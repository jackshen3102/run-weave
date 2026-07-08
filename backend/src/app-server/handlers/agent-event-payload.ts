import type {
  AgentHookStateEvent,
  TerminalAgentKind,
  TerminalCompletionEvent,
} from "@runweave/shared";

const AGENT_SOURCES = new Set(["codex", "trae", "traecli", "traex"]);
const HOOK_SOURCES = new Set([
  "claude",
  "codex",
  "trae",
  "traecli",
  "traex",
  "unknown",
]);
const STOP_EVENTS = new Set(["stop", "subagent_stop", "subagentstop"]);

export function readAppServerAgent(
  payload: unknown,
): TerminalAgentKind | null {
  const source = readAppServerPayloadString(payload, "source");
  return source && AGENT_SOURCES.has(source)
    ? (source as TerminalAgentKind)
    : null;
}

export function readAppServerHookSource(
  payload: unknown,
): TerminalCompletionEvent["source"] | null {
  const source = readAppServerPayloadString(payload, "source");
  return source && HOOK_SOURCES.has(source)
    ? (source as TerminalCompletionEvent["source"])
    : null;
}

export function readAppServerHookEvent(
  payload: unknown,
): AgentHookStateEvent | null {
  const stateHookEvent = readAppServerPayloadString(payload, "stateHookEvent");
  if (
    stateHookEvent === "SessionStart" ||
    stateHookEvent === "UserPromptSubmit" ||
    stateHookEvent === "Stop"
  ) {
    return stateHookEvent;
  }
  const rawEvent =
    readAppServerPayloadString(payload, "normalizedEvent") ??
    readAppServerPayloadString(payload, "rawHookEvent");
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

export function isAppServerStopCompletion(payload: unknown): boolean {
  if (readAppServerPayloadString(payload, "completionReason") !== "hook_stop") {
    return false;
  }
  const rawEvent =
    readAppServerPayloadString(payload, "rawHookEvent") ??
    readAppServerPayloadString(payload, "hookEvent");
  return rawEvent ? STOP_EVENTS.has(rawEvent.trim().toLowerCase()) : false;
}

export function readAppServerPayloadString(
  payload: unknown,
  key: string,
): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}
