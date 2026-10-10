import { randomUUID } from "node:crypto";
import WebSocket from "ws";
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

type Input = Extract<FeishuRequest, { type: "terminal.input" }>;
/** One outbound connection owned by the Backend. No Feishu credentials or inbound listener. */
export class FeishuBridgeConnector {
  private socket?: WebSocket;
  private ready = false;
  private stopped = true;
  private retry = 0;
  private reconnect?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private seenAt = 0;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: FeishuResultValue) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly work = new Set<Promise<void>>();
  constructor(
    private readonly options: {
      url: string;
      backendId: string;
      token: string;
      caCertificate?: string;
      getTerminal: (id: string) => Promise<{ status: "running" | "exited" }>;
      input: (
        input: Input,
      ) => Promise<{ inputAccepted: boolean; inputEnqueued: boolean }>;
      report: (report: unknown) => void;
    },
  ) {}
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  private connect(): void {
    if (this.stopped) return;
    const url = new URL(this.options.url);
    // HTTP is only used by isolated loopback integration fixtures; configuration accepts HTTPS only.
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/feishu/backends/${this.options.backendId}`;
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
      ca: this.options.caCertificate,
      handshakeTimeout: 5000,
      maxPayload: FEISHU_MAX_FRAME_BYTES,
      followRedirects: false,
    });
    this.socket = socket;
    this.ready = false;
    this.seenAt = Date.now();
    const helloTimeout = setTimeout(() => {
      if (!this.ready) socket.terminate();
    }, 5000);
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.seenAt >= 45_000) socket.terminate();
    }, 15_000);
    socket.on("ping", () => {
      this.seenAt = Date.now();
    });
    socket.on("error", () => {
      /* close owns retry; never log transport errors containing credentials */
    });
    socket.on("open", () =>
      socket.send(JSON.stringify({ type: "hello", protocolVersion: 1 })),
    );
    socket.on("close", () => {
      clearTimeout(helloTimeout);
      if (this.socket !== socket) return;
      clearInterval(this.heartbeat);
      this.ready = false;
      this.socket = undefined;
      for (const item of [...this.pending.values()])
        item.reject(new FeishuBridgeError("input_unknown"));
      if (!this.stopped) {
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retry++, 5));
        this.reconnect = setTimeout(
          () => this.connect(),
          Math.min(30_000, delay * (1 + Math.random() * 0.2)),
        );
      }
    });
    socket.on("message", (bytes) => {
      if (this.socket !== socket || this.stopped) return;
      try {
        const frame = parseFeishuFrame(String(bytes));
        this.seenAt = Date.now();
        if (!this.ready) {
          if (frame.type !== "ready") throw new Error("handshake");
          this.ready = true;
          this.retry = 0;
          clearTimeout(helloTimeout);
          return;
        }
        if (frame.type === "status") {
          this.options.report(frame.report);
          return;
        }
        if (frame.type === "result") {
          const item = this.pending.get(frame.requestId);
          if (frame.ok) item?.resolve(frame.value);
          else item?.reject(new FeishuBridgeError(frame.error));
          return;
        }
        if (frame.type !== "terminal.get" && frame.type !== "terminal.input")
          throw new Error("direction");
        if (this.work.size >= FEISHU_MAX_PENDING) {
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
        const work = this.execute(frame)
          .then(
            (value) => ({
              type: "result",
              requestId: frame.requestId,
              ok: true,
              value,
            }),
            (error) => ({
              type: "result",
              requestId: frame.requestId,
              ok: false,
              error:
                error instanceof FeishuBridgeError
                  ? error.code
                  : frame.type === "terminal.input"
                    ? "input_unknown"
                    : "unavailable",
            }),
          )
          .then((result) => {
            if (socket.readyState === WebSocket.OPEN)
              socket.send(JSON.stringify(result));
          })
          .finally(() => this.work.delete(work));
        this.work.add(work);
        void work.catch(() => socket.terminate());
      } catch {
        socket.close(1008, "Invalid bridge frame");
      }
    });
  }
  private async execute(
    frame: Extract<FeishuRequest, { type: "terminal.get" | "terminal.input" }>,
  ): Promise<FeishuResultValue> {
    if (frame.type === "terminal.get")
      return this.options.getTerminal(frame.terminalSessionId);
    if (Date.now() >= frame.expiresAt) throw new FeishuBridgeError("expired");
    return this.options.input(frame);
  }
  notify(payload: FeishuNotifyPayload): Promise<FeishuTopicResult> {
    if (
      !this.ready ||
      this.stopped ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return Promise.reject(new FeishuBridgeError("unavailable"));
    if (this.pending.size >= FEISHU_MAX_PENDING)
      return Promise.reject(new FeishuBridgeError("busy"));
    const socket = this.socket;
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: FeishuResultValue) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        if (error) reject(error);
        else if (value && "rootMessageId" in value) resolve(value);
        else reject(new FeishuBridgeError("input_unknown"));
      };
      const timer = setTimeout(
        () => finish(new FeishuBridgeError("input_unknown")),
        40_000,
      );
      this.pending.set(requestId, {
        resolve: (value) => finish(undefined, value),
        reject: (error) => finish(error),
      });
      socket.send(
        JSON.stringify({ type: "notify", requestId, ...payload }),
        (error) => {
          if (error) finish(new FeishuBridgeError("input_unknown"));
        },
      );
    });
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    const socket = this.socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        socket.once("close", resolve);
        socket.terminate();
      });
    }
    await Promise.allSettled([...this.work]);
  }
}
