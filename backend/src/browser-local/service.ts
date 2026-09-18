import net from "node:net";
import tls from "node:tls";
import { WebSocket } from "ws";
import {
  LOCAL_BROWSER_MAX_BUFFER,
  LOCAL_BROWSER_MAX_CONNECTIONS,
  LOCAL_BROWSER_MAX_FRAME,
  type LocalBrowserControl,
  type LocalBrowserError,
  type LocalBrowserOpen,
} from "@runweave/shared/browser-local-tunnel";

/** Never resolve caller-controlled DNS. Wildcards mean this computer, not a network. */
function loopback(host: string): string | null {
  if (
    host === "localhost" ||
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.localhost$/.test(host)
  )
    return "127.0.0.1";
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "::1") return "::1";
  if (net.isIPv4(host) && host.startsWith("127.")) return host;
  return null;
}

export class LocalBrowserService {
  readonly enabled = process.env.RUNWEAVE_BROWSER_LOCAL_ENABLED !== "0";
  private readonly streams = new Map<
    WebSocket,
    { authId: string; close: () => void }
  >();
  private disposed = false;

  constructor(
    private readonly sourceAvailable: (
      authId: string,
      terminalId: string,
    ) => boolean,
  ) {}

  accept(ws: WebSocket, authId: string): void {
    const send = (value: LocalBrowserControl) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
    };
    let target: net.Socket | undefined;
    let opened = false;
    let ready = false;
    let inputEnded = false;
    let terminalId = "";
    let alive = true;
    const close = () => {
      cleanup();
      ws.terminate();
    };
    const fail = (code: LocalBrowserError) => {
      send({ type: "error", code });
      cleanup();
      ws.close(1008, code);
      // Do not retain an outbound stream while waiting for an uncooperative peer.
      const timer = setTimeout(() => ws.terminate(), 1000);
      timer.unref();
      ws.once("close", () => clearTimeout(timer));
    };
    const timeout = setTimeout(() => fail("protocol_error"), 5000);
    let connectTimeout: NodeJS.Timeout | undefined;
    let ticks = 0;
    const heartbeat = setInterval(() => {
      if (terminalId && !this.sourceAvailable(authId, terminalId))
        return fail("source_unavailable");
      if (++ticks % 3 !== 0) return;
      if (!alive) return close();
      alive = false;
      ws.ping();
    }, 5000);
    heartbeat.unref();
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(connectTimeout);
      clearInterval(heartbeat);
      target?.destroy();
      this.streams.delete(ws);
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
    ws.on("pong", () => {
      alive = true;
    });
    if (this.disposed || !this.enabled) return fail("source_unavailable");
    if (
      [...this.streams.values()].filter((s) => s.authId === authId).length >=
      LOCAL_BROWSER_MAX_CONNECTIONS
    ) {
      return fail("connection_limit");
    }
    this.streams.set(ws, { authId, close });
    ws.on("message", (raw, binary) => {
      if (!this.streams.has(ws)) return;
      const data = Buffer.isBuffer(raw)
        ? raw
        : Buffer.concat(Array.isArray(raw) ? raw : [Buffer.from(raw)]);
      if (binary) {
        if (!ready || !target || inputEnded) return fail("protocol_error");
        if (
          data.length > LOCAL_BROWSER_MAX_FRAME ||
          target.writableLength + data.length > LOCAL_BROWSER_MAX_BUFFER
        )
          return fail("buffer_limit");
        if (!target.write(data)) {
          ws.pause();
          target.once("drain", () => ws.resume());
        }
        return;
      }
      if (data.length > 2048) return fail("protocol_error");
      let message: Partial<Omit<LocalBrowserOpen, "type">> & { type?: string };
      try {
        message = JSON.parse(data.toString());
      } catch {
        return fail("protocol_error");
      }
      if (!message || typeof message !== "object")
        return fail("protocol_error");
      if (opened) {
        if (message.type !== "eof" || !ready || inputEnded)
          return fail("protocol_error");
        inputEnded = true;
        target?.end();
        return;
      }
      if (message.type !== "open") return fail("protocol_error");
      if (message.version !== 1) return fail("unsupported_version");
      const host =
        typeof message.host === "string" ? loopback(message.host) : null;
      if (
        !host ||
        !Number.isInteger(message.port) ||
        message.port! < 1 ||
        message.port! > 65535 ||
        typeof message.secure !== "boolean"
      )
        return fail("invalid_target");
      if (
        typeof message.terminalSessionId !== "string" ||
        typeof message.browserSessionId !== "string" ||
        !/^[a-zA-Z0-9-]{1,80}$/.test(message.browserSessionId)
      )
        return fail("protocol_error");
      terminalId = message.terminalSessionId;
      if (!this.sourceAvailable(authId, terminalId))
        return fail("source_unavailable");
      opened = true;
      clearTimeout(timeout);
      connectTimeout = setTimeout(() => fail("connect_timeout"), 10000);
      const connected = () => {
        if (!this.streams.has(ws)) return;
        clearTimeout(connectTimeout);
        ready = true;
        send({ type: "ready" });
      };
      target = message.secure
        ? tls.connect(
            {
              host,
              port: message.port!,
              servername: net.isIP(message.host!) ? undefined : message.host,
              // Validate the original URL host even though routing never uses DNS.
              checkServerIdentity: (_name, cert) =>
                tls.checkServerIdentity(message.host!, cert),
            },
            connected,
          )
        : net.connect(
            { host, port: message.port!, allowHalfOpen: true },
            connected,
          );
      target.on("data", (chunk: Buffer) => {
        target!.pause();
        if (ws.readyState !== WebSocket.OPEN) return close();
        if (ws.bufferedAmount + chunk.length > LOCAL_BROWSER_MAX_BUFFER)
          return fail("buffer_limit");
        ws.send(chunk, { binary: true }, (error) => {
          if (error) close();
          else target?.resume();
        });
      });
      target.on("end", () => send({ type: "eof" }));
      target.on("error", () => fail("target_unavailable"));
      target.on("close", () => {
        if (this.streams.has(ws)) {
          cleanup();
          ws.close(1000);
        }
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const stream of [...this.streams.values()]) stream.close();
  }
}
