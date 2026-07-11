import type {
  AppServerAgentKind,
  AppServerAgentRunStatus,
  AppServerCompletionReason,
  AppServerEventEnvelope,
  AppServerThreadRef,
} from "@runweave/shared/app-server-events";
import {
  AppServerStateStore,
  buildFallbackThreadId,
  type StateRefUpdate,
  type StateStoreChange,
} from "./state-store.js";

export interface AppServerProjectionResult {
  threadChange: StateStoreChange<AppServerThreadRef> | null;
}

const AGENT_KINDS = new Set<AppServerAgentKind>([
  "claude",
  "codex",
  "trae",
  "traecli",
  "traex",
  "unknown",
]);
const STOP_EVENTS = new Set(["stop", "subagent_stop", "subagentstop"]);

export class AppServerStateProjector {
  constructor(private readonly stateStore: AppServerStateStore) {}

  project(event: AppServerEventEnvelope): AppServerProjectionResult {
    if (event.kind === "thread.state.changed") {
      return { threadChange: null };
    }
    if (event.kind !== "agent.hook" && event.kind !== "agent.completion") {
      return { threadChange: null };
    }

    const projection = buildProjection(event);
    if (!projection) {
      return { threadChange: null };
    }

    const threadChange = this.stateStore.upsertThread(projection);
    return { threadChange };
  }
}

function buildProjection(event: AppServerEventEnvelope): StateRefUpdate | null {
  const payload = readPayloadRecord(event.payload);
  const agent = readAgent(payload);
  const status =
    event.kind === "agent.hook"
      ? readHookStatus(payload)
      : readCompletionStatus(payload);
  if (!status) {
    return null;
  }

  const threadId =
    readString(payload, "threadId") ??
    event.correlationId?.trim() ??
    buildFallbackThreadId({
      agent,
      terminalSessionId: event.scope?.terminalSessionId ?? null,
      terminalPanelId: event.scope?.terminalPanelId ?? null,
      sourceInstanceId: event.source.instanceId,
      threadId: "",
    });
  const hookEvent = event.kind === "agent.hook" ? readHookEvent(payload) : null;
  const completionReason =
    event.kind === "agent.completion" ? readCompletionReason(payload) : null;

  return {
    agent,
    status,
    threadId,
    projectId: event.scope?.projectId ?? null,
    terminalSessionId: event.scope?.terminalSessionId ?? null,
    terminalPanelId: event.scope?.terminalPanelId ?? null,
    runId: event.scope?.runId ?? null,
    cwd: event.scope?.cwd ?? readString(payload, "cwd"),
    sourceInstanceId: event.source.instanceId,
    lastEventId: event.id,
    lastHookEvent: hookEvent,
    lastCompletionReason: completionReason,
    lastActivityAt: event.createdAt,
    updatedAt: event.createdAt,
  };
}

function readHookStatus(
  payload: Record<string, unknown>,
): AppServerAgentRunStatus | null {
  const hookEvent = readHookEvent(payload);
  if (hookEvent === "SessionStart") {
    return "starting";
  }
  if (hookEvent === "UserPromptSubmit") {
    return "running";
  }
  if (hookEvent === "Stop") {
    return "idle";
  }
  return null;
}

function readCompletionStatus(
  payload: Record<string, unknown>,
): AppServerAgentRunStatus | null {
  const reason = readCompletionReason(payload);
  if (reason === "ai_process_exit") {
    return "completed";
  }
  if (reason !== "hook_stop") {
    return null;
  }
  const rawEvent =
    readString(payload, "rawHookEvent") ?? readString(payload, "hookEvent");
  return rawEvent && STOP_EVENTS.has(rawEvent.trim().toLowerCase())
    ? "idle"
    : null;
}

function readHookEvent(payload: Record<string, unknown>): string | null {
  const stateHookEvent = readString(payload, "stateHookEvent");
  if (
    stateHookEvent === "SessionStart" ||
    stateHookEvent === "UserPromptSubmit" ||
    stateHookEvent === "Stop"
  ) {
    return stateHookEvent;
  }
  const rawEvent =
    readString(payload, "normalizedEvent") ??
    readString(payload, "rawHookEvent");
  if (!rawEvent) {
    return null;
  }
  const normalized = rawEvent.trim().toLowerCase();
  if (normalized === "sessionstart" || normalized === "session_start") {
    return "SessionStart";
  }
  if (
    normalized === "userpromptsubmit" ||
    normalized === "user_prompt_submit"
  ) {
    return "UserPromptSubmit";
  }
  if (STOP_EVENTS.has(normalized)) {
    return "Stop";
  }
  return null;
}

function readCompletionReason(
  payload: Record<string, unknown>,
): AppServerCompletionReason | null {
  const reason = readString(payload, "completionReason");
  return reason === "hook_stop" ||
    reason === "notify" ||
    reason === "ai_process_exit" ||
    reason === "manual"
    ? reason
    : null;
}

function readAgent(payload: Record<string, unknown>): AppServerAgentKind {
  const commandAgent = readAgentFromCommand(readString(payload, "commandName"));
  if (commandAgent) {
    return commandAgent;
  }
  const raw = readString(payload, "source") ?? readString(payload, "agent");
  return raw && AGENT_KINDS.has(raw as AppServerAgentKind)
    ? (raw as AppServerAgentKind)
    : "unknown";
}

function readAgentFromCommand(
  command: string | null,
): AppServerAgentKind | null {
  const basename = command
    ?.trim()
    .replace(/\\+/g, "/")
    .split("/")
    .filter(Boolean)
    .at(-1);
  if (
    basename === "codex" ||
    basename === "trae" ||
    basename === "traecli" ||
    basename === "traex"
  ) {
    return basename;
  }
  return null;
}

function readPayloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function readString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
