import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { EnvironmentContext } from "@runweave/shared/configuration";
import type { PtyHostDescriptor, PtyHostEvent } from "@runweave/shared/terminal/pty-host";
import { readHost } from "./discovery";
import { receiveJsonLines, sendJson } from "./transport";

/** A connection never owns the Host or its sessions. Lost requests are not replayed. */
export class PtyHostClient {
  readonly descriptor: PtyHostDescriptor;
  generation = 0;
  readonly events = new Set<(event: PtyHostEvent) => void>();
  readonly disconnected = new Set<() => void>();
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly socket: Socket;
  private readonly token: string;
  private connected = false;
  private constructor(scope: EnvironmentContext) {
    const discovery = readHost(scope);
    this.descriptor = discovery.descriptor;
    this.token = discovery.token;
    this.socket = createConnection(this.descriptor.endpoint);
    this.socket.on("error", () => {});
    this.socket.on("close", () => {
      this.connected = false;
      for (const request of this.pending.values()) request.reject(new Error("HOST_CONNECTION_LOST"));
      this.pending.clear();
      for (const listener of this.disconnected) listener();
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
  static async connect(scope: EnvironmentContext, ownerId?: string, expectedGeneration?: number, expectedHostInstanceId?: string): Promise<PtyHostClient> {
    const client = new PtyHostClient(scope);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { client.socket.destroy(); reject(new Error("HOST_CONNECT_TIMEOUT")); }, 5000);
        client.socket.once("error", error => { clearTimeout(timer); reject(error); });
        client.socket.once("connect", () => { clearTimeout(timer); client.connected = true; resolve(); });
      });
      const hello = await client.request<{ generation: number }>("hello", scope);
      if (ownerId) client.generation = (await client.request<{ generation: number }>("claimWriter", { ownerId, expectedGeneration: expectedHostInstanceId && expectedHostInstanceId !== client.descriptor.hostInstanceId ? hello.generation : expectedGeneration ?? hello.generation })).generation;
      return client;
    } catch (error) { client.close(); throw error; }
  }
  /** Aborting only releases this caller's wait; it does not cancel or replay Host operations. */
  request<T>(action: string, body: unknown = {}, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error("HOST_REQUEST_ABORTED"));
    if (!this.connected) return Promise.reject(new Error("HOST_CONNECTION_LOST"));
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(requestId);
      };
      const request = {
        resolve: (value: unknown) => { cleanup(); resolve(value as T); },
        reject: (error: Error) => { cleanup(); reject(error); },
      };
      const abort = () => request.reject(new Error("HOST_REQUEST_ABORTED"));
      const timer = setTimeout(() => request.reject(new Error("HOST_REQUEST_UNCERTAIN")), 15_000);
      this.pending.set(requestId, request);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (!sendJson(this.socket, { requestId, token: this.token, hostInstanceId: this.descriptor.hostInstanceId, action, body })) {
          request.reject(new Error("HOST_CONNECTION_LOST"));
        }
      } catch (error) { request.reject(error as Error); }
    });
  }
  close(): void { this.socket.destroy(); }
}
