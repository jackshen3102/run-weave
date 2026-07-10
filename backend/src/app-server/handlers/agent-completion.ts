import type { AppServerEventEnvelope } from "@runweave/shared";
import { logger } from "../../logging";
import { processTerminalAgentHook } from "../../terminal/agent-hook-processor";
import type { TerminalSessionManager } from "../../terminal/manager";
import type { TerminalStateService } from "../../terminal/terminal-state-service";
import {
  isAppServerStopCompletion,
  readAppServerAgent,
  readAppServerHookSource,
  readAppServerPayloadString,
} from "./agent-event-payload";
import { resolveAppServerTerminalAgent } from "./terminal-agent-context";

const agentCompletionLogger = logger.child({
  component: "app-server-agent-completion",
});

export interface AppServerAgentCompletionContext {
  projectId: string;
  terminalSessionId: string;
  panelId: string | null;
  tmuxPaneId: string | null;
  cwd: string;
}

export async function handleAgentCompletionEvent(
  event: AppServerEventEnvelope,
  options: {
    terminalSessionManager: TerminalSessionManager;
    terminalStateService: TerminalStateService;
  },
): Promise<AppServerAgentCompletionContext | null> {
  const terminalSessionId = event.scope?.terminalSessionId;
  const panelId =
    event.scope?.terminalPanelId ??
    readAppServerPayloadString(event.payload, "panelId");
  const tmuxPaneId =
    event.scope?.terminalTmuxPaneId ??
    readAppServerPayloadString(event.payload, "tmuxPaneId");
  const commandName = readAppServerPayloadString(event.payload, "commandName");
  const agent =
    readAppServerAgent(event.payload) ??
    (terminalSessionId
      ? resolveAppServerTerminalAgent({
          terminalSessionManager: options.terminalSessionManager,
          terminalSessionId,
          reportedSource: readAppServerHookSource(event.payload),
          panelId,
          tmuxPaneId,
          commandName,
        })
      : null);
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
  if (!terminalSessionId || !isAppServerStopCompletion(event.payload)) {
    return null;
  }

  const session = options.terminalSessionManager.getSession(terminalSessionId);
  if (!session) {
    agentCompletionLogger.info("app-server.agent-completion.fallback.skipped", {
      message: "App-server agent completion fallback skipped",
      eventId: event.id,
      terminalSessionId,
      agent,
      reason: "session_not_found",
    });
    return null;
  }
  const completionContext: AppServerAgentCompletionContext = {
    projectId: session.projectId,
    terminalSessionId,
    panelId: panelId ?? null,
    tmuxPaneId: tmuxPaneId ?? null,
    cwd: session.cwd,
  };
  if (!agent) {
    agentCompletionLogger.info("app-server.agent-completion.fallback.skipped", {
      message: "App-server agent completion fallback skipped",
      eventId: event.id,
      terminalSessionId,
      reason: "agent_not_resolved",
    });
    return completionContext;
  }

  const result = await processTerminalAgentHook(options, {
    terminalSessionId,
    agent,
    hookEvent: "Stop",
    threadId: event.correlationId,
    panelId,
    tmuxPaneId,
    commandName,
  });
  if (result.status === "not_found" || result.status === "exited") {
    return completionContext;
  }
  if (result.status === "ignored") {
    agentCompletionLogger.info("app-server.agent-completion.fallback.ignored", {
      message: "App-server agent completion fallback ignored",
      eventId: event.id,
      terminalSessionId: result.terminalSessionId,
      agent: result.agent,
      activeCommand: result.activeCommand,
      panelId: result.panelId,
      state: result.terminalState.state,
    });
    return completionContext;
  }

  agentCompletionLogger.info("app-server.agent-completion.fallback.recorded", {
    message: "App-server agent completion fallback updated terminal state",
    eventId: event.id,
    terminalSessionId: result.terminalSessionId,
    agent: result.agent,
    state: result.terminalState.state,
    panelId: result.panelId,
  });
  return completionContext;
}
