import { CliError } from "../errors.js";

interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Short-lived CDP client: no target creation, browser defaults or retries. */
export class BrowserCdpClient {
  private nextId = 0;
  private readonly pending = new Map<number, PendingCommand>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id === undefined) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new CliError(message.error.message, 4));
      else request.resolve(message.result);
    });
    socket.addEventListener("close", () => this.rejectPending());
    socket.addEventListener("error", () => this.rejectPending());
  }

  static async connect(endpoint: string): Promise<BrowserCdpClient> {
    let url = new URL(endpoint);
    if (url.protocol === "http:") {
      url.pathname = "/json/version";
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new CliError("CDP discovery failed", 3);
      const version = (await response.json()) as {
        webSocketDebuggerUrl: string;
      };
      url = new URL(version.webSocketDebuggerUrl);
    }
    if (
      url.protocol !== "ws:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    ) {
      throw new CliError(
        "Browser tools require a loopback WebSocket endpoint",
        2,
      );
    }
    const socket = new WebSocket(url);
    const client = new BrowserCdpClient(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new CliError("CDP connection timed out", 3)),
          5_000,
        );
        socket.addEventListener(
          "open",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        const fail = () => {
          clearTimeout(timer);
          reject(new CliError("CDP connection failed", 3));
        };
        socket.addEventListener("error", fail, { once: true });
        socket.addEventListener("close", fail, { once: true });
      });
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new CliError("CDP connection is closed", 3));
        return;
      }
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CliError(
            `${method} timed out; observe the page before retrying any action`,
            3,
          ),
        );
      }, 40_000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close(): void {
    this.rejectPending();
    this.socket.close();
  }

  private rejectPending(): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(
        new CliError(
          "CDP disconnected; in-flight tool effects are unknown, do not automatically retry",
          3,
        ),
      );
    }
    this.pending.clear();
  }
}
