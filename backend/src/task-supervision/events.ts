import type { AppServerEventEnvelope } from "@runweave/shared/app-server-events";
import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import { readAppServerPayloadString } from "../app-server/handlers/agent-event-payload";
import { isSupervisionPrompt } from "./context";

export interface ReplyEvent {
  kind: "reply";
  eventId: string;
  source: "terminal" | "app-server";
  terminalSessionId: string;
  panelId: string | null;
  threadId: string | null;
  summary: string | null;
  createdAt: string;
  turnId?: string | null;
}
export function completionReply(
  event: TerminalEventEnvelope,
): ReplyEvent | null {
  if (
    event.kind !== "completion" ||
    event.payload.completionReason !== "hook_stop" ||
    event.payload.rawHookEvent?.toLowerCase() !== "stop"
  )
    return null;
  return {
    kind: "reply",
    eventId: event.id,
    source: "terminal",
    terminalSessionId: event.terminalSessionId,
    panelId: event.payload.panelId ?? null,
    threadId: event.payload.threadId ?? null,
    summary: event.payload.summary ?? null,
    createdAt: event.createdAt,
  };
}
export function supervisionEvent(event: AppServerEventEnvelope) {
  const terminalSessionId = event.scope?.terminalSessionId;
  if (!terminalSessionId) return null;
  const read = (key: string) => readAppServerPayloadString(event.payload, key);
  const raw = (
    read("normalizedEvent") ??
    read("rawHookEvent") ??
    read("hookEvent") ??
    ""
  )
    .replaceAll("_", "")
    .toLowerCase();
  const scope = {
    eventId: event.id,
    source: "app-server" as const,
    terminalSessionId,
    panelId: event.scope?.terminalPanelId ?? read("panelId"),
    threadId: event.correlationId ?? read("threadId"),
    createdAt: event.createdAt,
  };
  if (event.kind === "agent.lifecycle.observed" && read("source") === "codex") {
    const lifecycle = read("observedLifecycle");
    if (lifecycle === "rollout:task_complete")
      return {
        ...scope,
        kind: "reply" as const,
        summary: null,
        turnId: read("turnId"),
      };
    if (
      lifecycle === "rollout:turn_aborted" ||
      read("observedStatus") === "running"
    )
      return {
        ...scope,
        kind: "hook" as const,
        raw:
          lifecycle === "rollout:turn_aborted"
            ? "interrupt"
            : "userpromptsubmit",
        toolName: null,
        native: true,
      };
    return null;
  }
  if (
    event.kind === "agent.completion" &&
    read("completionReason") === "hook_stop" &&
    raw === "stop"
  )
    return { ...scope, kind: "reply" as const, summary: read("summary") };
  if (
    event.kind !== "agent.hook" ||
    (raw === "userpromptsubmit" && isSupervisionPrompt(read("query") ?? ""))
  )
    return null;
  return {
    ...scope,
    kind: "hook" as const,
    raw,
    toolName: read("toolName"),
    native: false,
  };
}
