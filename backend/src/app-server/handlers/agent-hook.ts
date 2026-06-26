import type {
  AgentHookStateEvent,
  AppServerEventEnvelope,
  TerminalAgentKind,
} from "@runweave/shared";
import { logger } from "../../logging";
import { processTerminalAgentHook } from "../../terminal/agent-hook-processor";
import type { TerminalSessionManager } from "../../terminal/manager";
import type { TerminalStateService } from "../../terminal/terminal-state-service";

const agentHookLogger = logger.child({
  component: "app-server-agent-hook",
});

const AGENT_SOURCES = new Set(["codex", "trae", "traecli", "traex"]);
const STOP_EVENTS = new Set(["stop", "subagent_stop", "subagentstop"]);

export async function handleAgentHookEvent(
  event: AppServerEventEnvelope,
  options: {
    terminalSessionManager: TerminalSessionManager;
    terminalStateService: TerminalStateService;
  },
): Promise<void> {
  const terminalSessionId = event.scope?.terminalSessionId;
  const agent = readAgent(event.payload);
  const hookEvent = readHookEvent(event.payload);
  if (!terminalSessionId || !agent || !hookEvent) {
    agentHookLogger.debug("app-server.agent-hook.ignored", {
      message: "App-server agent hook event ignored",
      eventId: event.id,
      terminalSessionId: terminalSessionId ?? null,
      agent,
      hookEvent,
    });
    return;
  }

  const result = await processTerminalAgentHook(options, {
    terminalSessionId,
    agent,
    hookEvent,
    threadId: event.correlationId,
  });
  if (result.status === "not_found" || result.status === "exited") {
    return;
  }
  if (result.status === "ignored") {
    agentHookLogger.info("app-server.agent-hook.ignored", {
      message: "App-server agent hook ignored because agent is not current",
      eventId: event.id,
      terminalSessionId: result.terminalSessionId,
      agent: result.agent,
      hookEvent: result.hookEvent,
      activeCommand: result.activeCommand,
    });
    return;
  }

  agentHookLogger.info("app-server.agent-hook.recorded", {
    message: "App-server agent hook recorded",
    eventId: event.id,
    terminalSessionId: result.terminalSessionId,
    agent: result.agent,
    hookEvent: result.hookEvent,
    state: result.terminalState.state,
  });
}

function readAgent(payload: unknown): TerminalAgentKind | null {
  const source = readPayloadString(payload, "source");
  return source && AGENT_SOURCES.has(source)
    ? (source as TerminalAgentKind)
    : null;
}

function readHookEvent(payload: unknown): AgentHookStateEvent | null {
  const stateHookEvent = readPayloadString(payload, "stateHookEvent");
  if (
    stateHookEvent === "SessionStart" ||
    stateHookEvent === "UserPromptSubmit" ||
    stateHookEvent === "Stop"
  ) {
    return stateHookEvent;
  }
  const rawEvent =
    readPayloadString(payload, "normalizedEvent") ??
    readPayloadString(payload, "rawHookEvent");
  if (!rawEvent) {
    return null;
  }
  const normalizedEvent = rawEvent.trim().toLowerCase();
  if (normalizedEvent === "sessionstart" || normalizedEvent === "session_start") {
    return "SessionStart";
  }
  if (
    normalizedEvent === "userpromptsubmit" ||
    normalizedEvent === "user_prompt_submit"
  ) {
    return "UserPromptSubmit";
  }
  if (STOP_EVENTS.has(normalizedEvent)) {
    return "Stop";
  }
  return null;
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}
