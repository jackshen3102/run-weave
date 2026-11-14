import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { EnvironmentContext } from "@runweave/shared/configuration";
import type { PtyHostDescriptor, PtyHostEvent, PtyHostCapabilities } from "@runweave/shared/terminal/pty-host";
import { readHostAsync } from "./discovery";
import { HostTransportError, receiveJsonLines, sendJson } from "./transport";
import { diagnosticAction, hostErrorCode, reportHostDiagnostic, writeHostDiagnostic, type HostDiagnosticSink } from "./diagnostics";
export { hostErrorCode } from "./diagnostics";

/** A connection never owns the Host or its sessions. Lost requests are not replayed. */
export class PtyHostClient {
  readonly descriptor: PtyHostDescriptor;
  generation = 0;
  supportsSessionReplacement = false;
  readonly events = new Set<(event: PtyHostEvent) => void>();
  readonly disconnected = new Set<(error: Error) => void>();
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly socket: Socket;
  private readonly token: string;
  private connected = false;
  private readonly connectionId = randomUUID();
  private disconnectError?: Error;
  get isConnected(): boolean { return this.connected && !this.socket.destroyed; }
  private constructor(discovery: Awaited<ReturnType<typeof readHostAsync>>, private readonly diagnostic: HostDiagnosticSink) {
    this.descriptor = discovery.descriptor;
    this.token = discovery.token;
    this.socket = createConnection(this.descriptor.endpoint);
    this.socket.on("error", error => { this.disconnectError = error; });
    this.socket.on("close", () => {
      this.connected = false;
      const error = this.disconnectError ?? new Error("HOST_CONNECTION_LOST");
      reportHostDiagnostic(this.diagnostic, {
        event: "pty-host.connection.closed", hostInstanceId: this.descriptor.hostInstanceId, connectionId: this.connectionId,
        code: hostErrorCode(error), pendingRequests: this.pending.size, writableBytes: this.socket.writableLength,
        ...(error instanceof HostTransportError ? { bufferedBytes: error.bufferedBytes, limitBytes: error.limitBytes } : {}),
      });
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      for (const listener of this.disconnected) listener(error);
    });
    receiveJsonLines(this.socket, value => {
      const message = value as { requestId?: string; result?: unknown; error?: string; type?: string };
      if (message.requestId) {
        const request = this.pending.get(message.requestId);
        if (!request) return;
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
      } else if (message.type) for (const listener of this.events) listener(value as PtyHostEvent);
    });
  }
  static async connect(scope: EnvironmentContext, ownerId?: string, expectedGeneration?: number, expectedHostInstanceId?: string, diagnostic: HostDiagnosticSink = writeHostDiagnostic): Promise<PtyHostClient> {
    const requested = { ...scope };
    const client = new PtyHostClient(await readHostAsync(requested), diagnostic);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const error = new Error("HOST_CONNECT_TIMEOUT");
          client.disconnectError = error;
          client.socket.destroy(error); reject(error);
        }, 5000);
        client.socket.once("error", error => { clearTimeout(timer); reject(error); });
        client.socket.once("connect", () => { clearTimeout(timer); client.connected = true; resolve(); });
      });
      const hello = await client.request<{ generation: number; capabilities?: PtyHostCapabilities }>("hello", requested);
      client.supportsSessionReplacement = hello.capabilities?.replaceExitedSession === true;
      if (ownerId) client.generation = (await client.request<{ generation: number }>("claimWriter", { ownerId, expectedGeneration: expectedHostInstanceId && expectedHostInstanceId !== client.descriptor.hostInstanceId ? hello.generation : expectedGeneration ?? hello.generation })).generation;
      return client;
    } catch (error) { client.close(); throw error; }
  }
  /** Aborting only releases this caller's wait; it does not cancel or replay Host operations. */
  request<T>(action: string, body: unknown = {}, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error("HOST_REQUEST_ABORTED"));
    if (!this.isConnected) return Promise.reject(this.socket.errored ?? this.disconnectError ?? new Error("HOST_CONNECTION_LOST"));
    const requestId = randomUUID();
    const startedAt = performance.now();
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(requestId);
      };
      const request = {
        resolve: (value: unknown) => { cleanup(); resolve(value as T); },
        reject: (error: Error) => {
          reportHostDiagnostic(this.diagnostic, {
            event: "pty-host.request.failed", hostInstanceId: this.descriptor.hostInstanceId, connectionId: this.connectionId,
            requestId, action: diagnosticAction(action), code: hostErrorCode(error),
            elapsedMs: Math.round(performance.now() - startedAt), pendingRequests: this.pending.size,
            writableBytes: this.socket.writableLength,
          });
          cleanup(); reject(error);
        },
      };
      const abort = () => request.reject(new Error("HOST_REQUEST_ABORTED"));
      const timer = setTimeout(() => request.reject(new Error("HOST_REQUEST_UNCERTAIN")), 15_000);
      this.pending.set(requestId, request);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (!sendJson(this.socket, { requestId, token: this.token, hostInstanceId: this.descriptor.hostInstanceId, action, body })) {
          request.reject(this.socket.errored ?? new Error("HOST_CONNECTION_LOST"));
        }
      } catch (error) { request.reject(error as Error); }
    });
  }
  close(): void { this.disconnectError ??= new Error("HOST_CLIENT_CLOSED"); this.socket.destroy(); }
}
