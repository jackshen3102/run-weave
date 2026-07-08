import type { AppServerEventEnvelope } from "@runweave/shared";
import { logger } from "../../logging";
import { processTerminalAgentHook } from "../../terminal/agent-hook-processor";
import type { TerminalSessionManager } from "../../terminal/manager";
import type { TerminalStateService } from "../../terminal/terminal-state-service";
import {
  readAppServerAgent,
  readAppServerHookSource,
  readAppServerHookEvent,
  readAppServerPayloadString,
} from "./agent-event-payload";
import { resolveAppServerTerminalAgent } from "./terminal-agent-context";

const agentHookLogger = logger.child({
  component: "app-server-agent-hook",
});

export async function handleAgentHookEvent(
  event: AppServerEventEnvelope,
  options: {
    terminalSessionManager: TerminalSessionManager;
    terminalStateService: TerminalStateService;
  },
): Promise<void> {
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
  const hookEvent = readAppServerHookEvent(event.payload);
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
    panelId,
    tmuxPaneId,
    commandName,
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
      panelId: result.panelId,
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
    panelId: result.panelId,
  });
}
