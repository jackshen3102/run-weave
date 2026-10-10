import { createServer } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  FEISHU_MAX_FRAME_BYTES,
  FEISHU_MAX_PENDING,
  FeishuBridgeError,
  parseFeishuFrame,
  type FeishuRequest,
  type FeishuResultValue,
  type FeishuNotifyPayload,
  type FeishuTopicResult,
} from "@runweave/shared/feishu/bridge";
import type { RuntimeStatusReport } from "@runweave/shared/runtime-status";

type Pending = {
  resolve: (value: FeishuResultValue) => void;
  reject: (error: Error) => void;
};
interface Connection {
  socket: WebSocket;
  ready: boolean;
  seenAt: number;
  pending: Map<string, Pending>;
  incoming: Set<string>;
}
export class FeishuHubServer {
  private readonly server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  private readonly ws = new WebSocketServer({
    noServer: true,
    maxPayload: FEISHU_MAX_FRAME_BYTES,
  });
  private readonly nodes = new Map<string, Connection>();
  private readonly work = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  constructor(
    private readonly options: {
      host: string;
      port: number;
      tokens: ReadonlyMap<string, string>;
      notify: (
        backendId: string,
        payload: FeishuNotifyPayload,
      ) => Promise<FeishuTopicResult>;
    },
  ) {
    this.server.headersTimeout = 5000;
    this.server.on("upgrade", (req, socket, head) => {
      const id = /^\/feishu\/backends\/([a-f0-9]{64})$/.exec(
        req.url ?? "",
      )?.[1];
      const expected = id ? this.options.tokens.get(id) : undefined;
      const supplied = req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : undefined;
      const valid =
        expected &&
        supplied &&
        Buffer.byteLength(expected) === Buffer.byteLength(supplied) &&
        timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
      if (this.stopping || !id || !valid || this.nodes.has(id)) {
        socket.end(
          `HTTP/1.1 ${valid ? "409 Conflict" : "401 Unauthorized"}\r\nConnection: close\r\n\r\n`,
        );
        return;
      }
      this.ws.handleUpgrade(req, socket, head, (ws) => this.attach(id, ws));
    });
  }
  async start(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.timer = setInterval(() => {
      for (const node of this.nodes.values()) {
        if (Date.now() - node.seenAt >= 45_000) node.socket.terminate();
        else node.socket.ping();
      }
    }, 15_000);
    return (this.server.address() as { port: number }).port;
  }
  private attach(id: string, socket: WebSocket): void {
    const node: Connection = {
      socket,
      ready: false,
      seenAt: Date.now(),
      pending: new Map(),
      incoming: new Set(),
    };
    this.nodes.set(id, node);
    const handshake = setTimeout(() => socket.terminate(), 5000);
    socket.on("pong", () => {
      node.seenAt = Date.now();
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      clearTimeout(handshake);
      if (this.nodes.get(id) === node) this.nodes.delete(id);
      for (const pending of [...node.pending.values()])
        pending.reject(new FeishuBridgeError("unavailable"));
    });
    socket.on("message", (bytes) => {
      try {
        const frame = parseFeishuFrame(String(bytes));
        if (!node.ready) {
          if (frame.type !== "hello") throw new Error("handshake");
          node.ready = true;
          clearTimeout(handshake);
          socket.send(JSON.stringify({ type: "ready", protocolVersion: 1 }));
          return;
        }
        if (frame.type === "result") {
          const pending = node.pending.get(frame.requestId);
          if (frame.ok) pending?.resolve(frame.value);
          else pending?.reject(new FeishuBridgeError(frame.error));
          return;
        }
        if (frame.type !== "notify") throw new Error("direction");
        if (node.incoming.has(frame.requestId)) throw new Error("duplicate");
        if (node.incoming.size >= FEISHU_MAX_PENDING) {
          socket.send(
            JSON.stringify({
              type: "result",
              requestId: frame.requestId,
              ok: false,
              error: "busy",
            }),
          );
          return;
        }
        node.incoming.add(frame.requestId);
        const work = this.options
          .notify(id, {
            terminalSessionId: frame.terminalSessionId,
            notificationText: frame.notificationText,
          })
          .then(
            (value) => ({
              type: "result",
              requestId: frame.requestId,
              ok: true,
              value,
            }),
            () => ({
              type: "result",
              requestId: frame.requestId,
              ok: false,
              error: "input_unknown",
            }),
          )
          .then((result) => {
            if (socket.readyState === WebSocket.OPEN)
              socket.send(JSON.stringify(result));
          })
          .finally(() => {
            node.incoming.delete(frame.requestId);
            this.work.delete(work);
          });
        this.work.add(work);
        void work.catch(() => socket.terminate());
      } catch {
        socket.close(1008, "Invalid bridge frame");
      }
    });
  }
  request(
    backendId: string,
    payload:
      | Omit<Extract<FeishuRequest, { type: "terminal.get" }>, "requestId">
      | Omit<Extract<FeishuRequest, { type: "terminal.input" }>, "requestId">,
    signal: AbortSignal,
  ): Promise<FeishuResultValue> {
    signal.throwIfAborted();
    const node = this.nodes.get(backendId);
    if (!node?.ready || node.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new FeishuBridgeError("unavailable"));
    if (node.pending.size >= FEISHU_MAX_PENDING)
      return Promise.reject(new FeishuBridgeError("busy"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: FeishuResultValue) => {
        node.pending.delete(requestId);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(value!);
      };
      const abort = () => finish(new FeishuBridgeError("unavailable"));
      node.pending.set(requestId, {
        resolve: (v) => finish(undefined, v),
        reject: (e) => finish(e),
      });
      signal.addEventListener("abort", abort, { once: true });
      node.socket.send(JSON.stringify({ ...payload, requestId }), (error) => {
        if (error) finish(new FeishuBridgeError("unavailable"));
      });
    });
  }
  publish(report: RuntimeStatusReport): void {
    const frame = JSON.stringify({ type: "status", report });
    for (const node of this.nodes.values())
      if (node.ready && node.socket.readyState === WebSocket.OPEN)
        node.socket.send(frame);
  }
  async close(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    for (const node of this.nodes.values()) node.socket.terminate();
    this.server.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => this.server.close(() => resolve())),
      new Promise<void>((resolve) => this.ws.close(() => resolve())),
      Promise.allSettled([...this.work]),
    ]);
  }
}
