import net from "node:net";
import { lstat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { ScreenRecordingMethod, ScreenRecordingSocketResponse } from "@runweave/shared/screen-recording";

export class ScreenRecordingFailure extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryable = false) { super(code); }
}
export class ScreenRecordingClient {
  private readonly sockets = new Set<net.Socket>();
  private closed = false;
  private readonly socketPath = process.env.RUNWEAVE_SCREEN_JOURNAL_SOCKET ?? path.join(os.homedir(), "Library/Application Support/ScreenJournal/runtime/read.sock");
  async request(method: ScreenRecordingMethod, params: Record<string, string | number>, signal?: AbortSignal): Promise<{ header: ScreenRecordingSocketResponse; body: Buffer }> {
    if (process.platform !== "darwin") throw new ScreenRecordingFailure(503, "UNSUPPORTED");
    if (this.closed || signal?.aborted) throw new ScreenRecordingFailure(503, "NOT_RUNNING");
    if (this.sockets.size >= 4) throw new ScreenRecordingFailure(429, "BUSY", true);
    if (!path.isAbsolute(this.socketPath) || Buffer.byteLength(this.socketPath) >= 104) throw new ScreenRecordingFailure(503, "UNSAFE_SOCKET");
    try {
      let current = this.socketPath;
      while (current !== path.dirname(current)) {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new ScreenRecordingFailure(503, "UNSAFE_SOCKET");
        if (current === this.socketPath && (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600)) throw new ScreenRecordingFailure(503, "UNSAFE_SOCKET");
        if (current === path.dirname(this.socketPath) && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)) throw new ScreenRecordingFailure(503, "UNSAFE_SOCKET");
        current = path.dirname(current);
      }
    } catch (error) {
      if (error instanceof ScreenRecordingFailure) throw error;
      throw new ScreenRecordingFailure(503, "NOT_RUNNING", true);
    }
    if (this.closed || signal?.aborted) throw new ScreenRecordingFailure(503, "NOT_RUNNING");
    if (this.sockets.size >= 4) throw new ScreenRecordingFailure(429, "BUSY", true);
    return new Promise((resolve, reject) => {
      const socket = new net.Socket(); this.sockets.add(socket);
      const requestId = randomUUID();
      let received = Buffer.alloc(0); let header: ScreenRecordingSocketResponse | undefined; let headerSize: number | undefined; let done = false;
      const finish = (error?: Error, value?: { header: ScreenRecordingSocketResponse; body: Buffer }) => {
        if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); this.sockets.delete(socket); socket.destroy();
        if (error) reject(error); else if (value) resolve(value);
      };
      const abort = () => finish(new ScreenRecordingFailure(503, "CANCELLED"));
      const timer = setTimeout(() => finish(new ScreenRecordingFailure(504, "TIMEOUT", true)), 5000);
      signal?.addEventListener("abort", abort, { once: true });
      socket.on("error", () => finish(new ScreenRecordingFailure(503, "NOT_RUNNING", true)));
      socket.on("end", () => { if (!done) finish(new ScreenRecordingFailure(503, "MEDIA_UNAVAILABLE")); });
      socket.on("close", () => { if (!done) finish(new ScreenRecordingFailure(503, "NOT_RUNNING", true)); });
      socket.on("data", chunk => {
        if (received.length + chunk.length > 8 * 1024 * 1024 + 65540) return finish(new ScreenRecordingFailure(503, "INVALID_PROTOCOL"));
        received = Buffer.concat([received, chunk]);
        try {
          if (headerSize === undefined && received.length >= 4) {
            headerSize = received.readUInt32BE(0); received = received.subarray(4);
            if (headerSize === 0 || headerSize > 65536) throw new Error("header");
          }
          if (!header && headerSize !== undefined && received.length >= headerSize) {
            const candidate: unknown = JSON.parse(received.subarray(0, headerSize).toString("utf8")); received = received.subarray(headerSize);
            if (!candidate || typeof candidate !== "object") throw new Error("header");
            const h = candidate as ScreenRecordingSocketResponse;
            if (h.requestId !== requestId || !Number.isInteger(h.status) || h.status < 200 || h.status > 599 || typeof h.code !== "string" || typeof h.serverEpoch !== "string" || !Number.isInteger(h.payloadLength) || h.payloadLength < 0 || h.payloadLength > 8 * 1024 * 1024 || !["application/json", "image/jpeg"].includes(h.contentType)) throw new Error("header");
            header = h;
          }
          if (header && received.length >= header.payloadLength) {
            if (received.length !== header.payloadLength) throw new Error("body");
            if (header.status !== 200) return finish(new ScreenRecordingFailure(header.status, /^[A-Z_]+$/.test(header.code) ? header.code : "MEDIA_UNAVAILABLE", [409,429,503,504].includes(header.status)));
            finish(undefined, { header, body: received });
          }
        } catch { finish(new ScreenRecordingFailure(503, "INVALID_PROTOCOL")); }
      });
      socket.connect(this.socketPath, () => {
        const bytes = Buffer.from(JSON.stringify({ version: 1, requestId, method, params, payloadLength: 0 }));
        const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); socket.write(Buffer.concat([length, bytes]));
      });
      if (signal?.aborted) abort();
    });
  }
  dispose(): void { this.closed = true; for (const socket of this.sockets) socket.destroy(); this.sockets.clear(); }
}
