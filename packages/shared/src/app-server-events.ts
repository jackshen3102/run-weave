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
  terminalTmuxPaneId?: string | null;
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

export type AppServerAgentKind =
  | "claude"
  | "codex"
  | "trae"
  | "traecli"
  | "traex"
  | "unknown";

export type AppServerAgentRunStatus =
  | "starting"
  | "running"
  | "idle"
  | "completed"
  | "failed"
  | "unknown";

export type AppServerThreadLifecycleStatus =
  | "available"
  | "degraded"
  | "unknown";

export interface AppServerThreadLifecycleEvent {
  cursor: string;
  type: string;
  timestamp: string | null;
  turnId: string | null;
  raw: Record<string, unknown>;
}

export interface AppServerThreadTurn {
  turnId: string;
  status: "running" | "completed" | "interrupted";
  startedAt: string | null;
  completedAt: string | null;
  preview: string | null;
}

export interface AppServerThreadDetail {
  provider: AppServerAgentKind;
  id: string;
  status: "running" | "idle" | "interrupted" | "unknown";
  preview: string | null;
  turns: AppServerThreadTurn[];
  lifecycle: AppServerThreadLifecycleEvent[];
  lastLifecycleCursor: string | null;
  sourcePath: string | null;
}

export interface AppServerThreadRef {
  threadId: string;
  agent: AppServerAgentKind;
  status: AppServerAgentRunStatus;
  projectId: string | null;
  terminalSessionId: string | null;
  terminalPanelId: string | null;
  runId: string | null;
  cwd: string | null;
  detailRef?: {
    provider: AppServerAgentKind;
    id: string;
  } | null;
  identityStatus: "resolved" | "unresolved";
  lifecycleStatus: AppServerThreadLifecycleStatus;
  lastLifecycleType: string | null;
  lastLifecycleCursor: string | null;
  sourceInstanceId: string | null;
  lastEventId: string;
  lastHookEvent: string | null;
  lastCompletionReason: AppServerCompletionReason | null;
  lastActivityAt: string;
  updatedAt: string;
}

export interface AppServerThreadStateChangedPayload {
  thread: AppServerThreadRef;
  previous: AppServerThreadRef | null;
}

export interface AppServerThreadListResponse {
  threads: AppServerThreadRef[];
  latestEventId: string | null;
}

export interface AppServerThreadResponse {
  thread: AppServerThreadRef;
  detail?: AppServerThreadDetail | null;
}

export interface AppServerSyncStatusResponse {
  enabled: boolean;
  syncDir: string;
  latestSyncedEventId: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}
