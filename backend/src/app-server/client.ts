import { WebSocket } from "ws";
import type {
  AppServerEventEnvelope,
  AppServerEventListResponse,
  AppServerEventStreamMessage,
  CreateAppServerEventRequest,
} from "@runweave/shared";
import type { AppServerConnectionInfo } from "@runweave/shared/src/app-server-node";

export class AppServerClient {
  constructor(private readonly connection: AppServerConnectionInfo) {}

  async postEvent(
    event: CreateAppServerEventRequest,
  ): Promise<AppServerEventEnvelope | null> {
    const response = await fetch(`${this.connection.baseUrl}/events`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(event),
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { event?: AppServerEventEnvelope };
    return body.event ?? null;
  }

  async listEvents(options: {
    after: string | null;
    kinds: string[];
    limit?: number;
  }): Promise<AppServerEventListResponse | null> {
    const url = new URL(`${this.connection.baseUrl}/events`);
    if (options.after) {
      url.searchParams.set("after", options.after);
    }
    for (const kind of options.kinds) {
      url.searchParams.append("kind", kind);
    }
    if (options.limit) {
      url.searchParams.set("limit", String(options.limit));
    }
    const response = await fetch(url, { headers: this.headers() });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as AppServerEventListResponse;
  }

  connectStream(options: {
    after: string | null;
    kinds: string[];
    onMessage: (message: AppServerEventStreamMessage) => void;
    onClose: () => void;
    onError: (error: Error) => void;
  }): WebSocket {
    const url = new URL(
      `${this.connection.baseUrl.replace(/^http/, "ws")}/events/stream`,
    );
    if (options.after) {
      url.searchParams.set("after", options.after);
    }
    for (const kind of options.kinds) {
      url.searchParams.append("kind", kind);
    }

    const socket = new WebSocket(url, {
      headers: this.headers(),
    });
    socket.on("message", (raw) => {
      try {
        options.onMessage(JSON.parse(String(raw)) as AppServerEventStreamMessage);
      } catch (error) {
        options.onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("close", options.onClose);
    socket.on("error", options.onError);
    return socket;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...extra,
      Authorization: `Bearer ${this.connection.token}`,
    };
  }
}
