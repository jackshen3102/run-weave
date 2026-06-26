import type { AppServerEventEnvelope } from "@runweave/shared";
import { logger } from "../../logging";

const agentCompletionLogger = logger.child({
  component: "app-server-agent-completion",
});

export async function handleAgentCompletionEvent(
  event: AppServerEventEnvelope,
): Promise<void> {
  agentCompletionLogger.info("app-server.agent-completion.received", {
    message: "App-server agent completion event received",
    eventId: event.id,
    terminalSessionId: event.scope?.terminalSessionId ?? null,
    projectId: event.scope?.projectId ?? null,
    source: readPayloadString(event.payload, "source"),
  });
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}
