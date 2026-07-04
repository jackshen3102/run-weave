import type { AppServerEventEnvelope } from "@runweave/shared";
import { logger } from "../../logging";
import { processTerminalAgentHook } from "../../terminal/agent-hook-processor";
import type { TerminalSessionManager } from "../../terminal/manager";
import type { TerminalStateService } from "../../terminal/terminal-state-service";
import {
  isAppServerStopCompletion,
  readAppServerAgent,
  readAppServerPayloadString,
} from "./agent-event-payload";

const agentCompletionLogger = logger.child({
  component: "app-server-agent-completion",
});

export async function handleAgentCompletionEvent(
  event: AppServerEventEnvelope,
  options: {
    terminalSessionManager: TerminalSessionManager;
    terminalStateService: TerminalStateService;
  },
): Promise<void> {
  const terminalSessionId = event.scope?.terminalSessionId;
  const agent = readAppServerAgent(event.payload);
  agentCompletionLogger.info("app-server.agent-completion.received", {
    message: "App-server agent completion event received",
    eventId: event.id,
    terminalSessionId: terminalSessionId ?? null,
    projectId: event.scope?.projectId ?? null,
    source: readAppServerPayloadString(event.payload, "source"),
    completionReason: readAppServerPayloadString(
      event.payload,
      "completionReason",
    ),
  });
  if (!terminalSessionId || !agent || !isAppServerStopCompletion(event.payload)) {
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
