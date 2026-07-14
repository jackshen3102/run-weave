import { WebSocket } from "ws";
import type { AppServerEventEnvelope, AppServerEventListResponse, AppServerEventStreamMessage, AppServerSyncStatusResponse, AppServerThreadDetailResponse, AppServerThreadListResponse, AppServerThreadResponse, CreateAppServerEventRequest } from "@runweave/shared/app-server-events";
import type { AppServerConnectionInfo } from "@runweave/shared/app-server/types";

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

  async listThreads(options: {
    projectId?: string;
    terminalSessionId?: string;
    terminalPanelId?: string;
    agent?: string;
    status?: string;
    after?: string | null;
    limit?: number;
  } = {}, signal?: AbortSignal): Promise<AppServerThreadListResponse | null> {
    const response = await fetch(
      this.buildStateUrl("/threads", options),
      { headers: this.headers(), signal },
    );
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as AppServerThreadListResponse;
  }

  async getThreadDetail(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<AppServerThreadDetailResponse | "thread_not_found" | null> {
    const response = await fetch(
      `${this.connection.baseUrl}/threads/${encodeURIComponent(threadId)}/detail`,
      { headers: this.headers(), signal },
    );
    if (response.status === 404) {
      return "thread_not_found";
    }
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as AppServerThreadDetailResponse;
  }

  async getThread(threadId: string): Promise<AppServerThreadResponse | null> {
    const response = await fetch(
      `${this.connection.baseUrl}/threads/${encodeURIComponent(threadId)}`,
      { headers: this.headers() },
    );
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as AppServerThreadResponse;
  }

  async getSyncStatus(): Promise<AppServerSyncStatusResponse | null> {
    const response = await fetch(`${this.connection.baseUrl}/sync/status`, {
      headers: this.headers(),
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as AppServerSyncStatusResponse;
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

  private buildStateUrl(
    pathname: string,
    options: {
      projectId?: string;
      terminalSessionId?: string;
      terminalPanelId?: string;
      agent?: string;
      status?: string;
      after?: string | null;
      limit?: number;
    },
  ): string {
    const url = new URL(`${this.connection.baseUrl}${pathname}`);
    if (options.projectId) {
      url.searchParams.set("projectId", options.projectId);
    }
    if (options.terminalSessionId) {
      url.searchParams.set("terminalSessionId", options.terminalSessionId);
    }
    if (options.terminalPanelId) {
      url.searchParams.set("terminalPanelId", options.terminalPanelId);
    }
    if (options.agent) {
      url.searchParams.set("agent", options.agent);
    }
    if (options.status) {
      url.searchParams.set("status", options.status);
    }
    if (options.after) {
      url.searchParams.set("after", options.after);
    }
    if (options.limit) {
      url.searchParams.set("limit", String(options.limit));
    }
    return url.toString();
  }
}
