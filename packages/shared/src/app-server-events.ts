export type AppServerEventSourceApp =
  | "app-server"
  | "backend"
  | "electron"
  | "cli"
  | "hook"
  | "unknown";

export interface AppServerEventSource {
  app: AppServerEventSourceApp;
  instanceId: string;
  pid?: number;
}

export interface AppServerEventScope {
  projectId?: string | null;
  terminalSessionId?: string | null;
  terminalPanelId?: string | null;
  runId?: string | null;
  cwd?: string | null;
}

export interface AppServerEventEnvelope {
  id: string;
  version: 1;
  kind: string;
  source: AppServerEventSource;
  scope?: AppServerEventScope;
  dedupeKey?: string | null;
  correlationId?: string | null;
  payload: unknown;
  createdAt: string;
}

export interface CreateAppServerEventRequest {
  kind: string;
  source: AppServerEventSource;
  scope?: AppServerEventScope;
  dedupeKey?: string | null;
  correlationId?: string | null;
  payload: unknown;
}

export interface AppServerEventListResponse {
  events: AppServerEventEnvelope[];
  latestEventId: string | null;
}

export interface AppServerEventLatestResponse {
  latestEventId: string | null;
}

export type AppServerEventStreamMessage =
  | { type: "connected"; acceptedAfter: string | null }
  | {
      type: "events";
      delivery: "catchup";
      events: AppServerEventEnvelope[];
    }
  | { type: "event"; delivery: "live"; event: AppServerEventEnvelope }
  | { type: "error"; message: string };

export type AppServerHookSource =
  | "claude"
  | "codex"
  | "trae"
  | "traecli"
  | "traex"
  | "unknown";

export type AppServerCompletionReason =
  | "hook_stop"
  | "notify"
  | "ai_process_exit"
  | "manual";
