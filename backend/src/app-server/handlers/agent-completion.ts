import type { AppServerEventEnvelope, TerminalAgentKind } from "@runweave/shared";
import { logger } from "../../logging";
import { processTerminalAgentHook } from "../../terminal/agent-hook-processor";
import type { TerminalSessionManager } from "../../terminal/manager";
import type { TerminalStateService } from "../../terminal/terminal-state-service";

const agentCompletionLogger = logger.child({
  component: "app-server-agent-completion",
});
const AGENT_SOURCES = new Set(["codex", "trae", "traecli", "traex"]);
const STOP_EVENTS = new Set(["stop", "subagent_stop", "subagentstop"]);

export async function handleAgentCompletionEvent(
  event: AppServerEventEnvelope,
  options: {
    terminalSessionManager: TerminalSessionManager;
    terminalStateService: TerminalStateService;
  },
): Promise<void> {
  const terminalSessionId = event.scope?.terminalSessionId;
  const agent = readAgent(event.payload);
  agentCompletionLogger.info("app-server.agent-completion.received", {
    message: "App-server agent completion event received",
    eventId: event.id,
    terminalSessionId: terminalSessionId ?? null,
    projectId: event.scope?.projectId ?? null,
    source: readPayloadString(event.payload, "source"),
    completionReason: readPayloadString(event.payload, "completionReason"),
  });
  if (!terminalSessionId || !agent || !isStopCompletion(event.payload)) {
    return;
  }

  if (!options.terminalSessionManager.getSession(terminalSessionId)) {
    agentCompletionLogger.info("app-server.agent-completion.fallback.skipped", {
      message: "App-server agent completion fallback skipped",
      eventId: event.id,
      terminalSessionId,
      agent,
      reason: "session_not_found",
    });
    return;
  }

  const result = await processTerminalAgentHook(options, {
    terminalSessionId,
    agent,
    hookEvent: "Stop",
    threadId: event.correlationId,
  });
  if (result.status === "not_found" || result.status === "exited") {
    return;
  }
  if (result.status === "ignored") {
    agentCompletionLogger.info("app-server.agent-completion.fallback.ignored", {
      message: "App-server agent completion fallback ignored",
      eventId: event.id,
      terminalSessionId: result.terminalSessionId,
      agent: result.agent,
      activeCommand: result.activeCommand,
      state: result.terminalState.state,
    });
    return;
  }

  agentCompletionLogger.info("app-server.agent-completion.fallback.recorded", {
    message: "App-server agent completion fallback updated terminal state",
    eventId: event.id,
    terminalSessionId: result.terminalSessionId,
    agent: result.agent,
    state: result.terminalState.state,
  });
}

function readAgent(payload: unknown): TerminalAgentKind | null {
  const source = readPayloadString(payload, "source");
  return source && AGENT_SOURCES.has(source)
    ? (source as TerminalAgentKind)
    : null;
}

function isStopCompletion(payload: unknown): boolean {
  if (readPayloadString(payload, "completionReason") !== "hook_stop") {
    return false;
  }
  const rawEvent =
    readPayloadString(payload, "rawHookEvent") ??
    readPayloadString(payload, "hookEvent");
  return rawEvent ? STOP_EVENTS.has(rawEvent.trim().toLowerCase()) : false;
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}
