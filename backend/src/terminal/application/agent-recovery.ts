import type {
  RecoverTerminalAgentRequest,
  RecoverTerminalAgentResponse,
} from "@runweave/shared/terminal/agent-preparation";
import type {
  TerminalPanelRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager/manager";
import { logger } from "../../logging/index";
import { getAgentForCommand } from "../state/terminal-state-service";
import { isInteractiveShellLaunch } from "../tmux/output-watcher-helpers";
import { prepareTerminalAgent } from "./agent-preparation";
import { TerminalPanelError, type TerminalPanelOptions } from "./panel-common";
import { resolvePanelTarget } from "./panel-targets";

const agentRecoveryLogger = logger.child({
  component: "terminal-agent-recovery",
});

export async function recoverTerminalAgent(
  terminalSessionManager: TerminalSessionManager,
  session: TerminalSessionRecord,
  options: TerminalPanelOptions,
  request: RecoverTerminalAgentRequest,
): Promise<RecoverTerminalAgentResponse> {
  const { panel } = await resolvePanelTarget(
    terminalSessionManager,
    session,
    options,
    { panelId: request.panelId },
    "explicit-or-active",
  );

  const agent = panel.terminalState?.agent;
  if (
    panel.terminalState?.state !== "agent_idle" ||
    (agent !== "codex" && agent !== "pi")
  ) {
    throw new TerminalPanelError(
      409,
      "Only an idle Codex or Pi panel can be recovered",
    );
  }
  if (!isInteractiveShellLaunch(session.command, session.args)) {
    throw new TerminalPanelError(
      409,
      "Terminal session command is not a persistent interactive shell",
    );
  }
  if (getAgentForCommand(panel.activeCommand) !== agent) {
    throw new TerminalPanelError(409, "Terminal panel is not running the requested agent");
  }

  const resumedThreadId = resolveAgentThreadToRecover(
    terminalSessionManager,
    session,
    panel,
    agent,
  );
  if (!resumedThreadId) {
    throw new TerminalPanelError(
      409,
      "Terminal panel has no saved agent thread",
    );
  }

  agentRecoveryLogger.warn("terminal.agent-recovery.requested", {
    message: "Idle agent panel recovery requested",
    terminalSessionId: session.id,
    panelId: panel.id,
    tmuxPaneId: panel.tmuxPaneId,
    threadId: resumedThreadId,
  });

  const result = await prepareTerminalAgent(
    terminalSessionManager,
    session,
    options,
    {
      agent,
      prompt: "",
      panelId: panel.id,
      cwd: panel.cwd,
      resumeThreadId: resumedThreadId,
    },
    {
      resetPanelBeforeResume: true,
      skipInitialPrompt: true,
    },
  );

  agentRecoveryLogger.info("terminal.agent-recovery.started", {
    message: "Agent panel respawned and saved thread resume started",
    terminalSessionId: session.id,
    panelId: panel.id,
    tmuxPaneId: panel.tmuxPaneId,
    threadId: resumedThreadId,
    operationId: result.operationId,
  });

  return {
    ...result,
    resumedThreadId,
    recoveryMode: "pane_respawn",
  };
}

function resolveAgentThreadToRecover(
  terminalSessionManager: TerminalSessionManager,
  session: TerminalSessionRecord,
  panel: TerminalPanelRecord,
  agent: "codex" | "pi",
): string | null {
  const panelThreadId = readAgentThreadId(panel, agent);
  if (panelThreadId) {
    return panelThreadId;
  }
  const runningPanels = terminalSessionManager
    .listPanels(session.id)
    .filter((candidate) => candidate.status === "running");
  return runningPanels.length === 1 ? readAgentThreadId(session, agent) : null;
}

function readAgentThreadId(
  source: Pick<
    TerminalPanelRecord | TerminalSessionRecord,
    "threadId" | "threadProvider" | "lastThreadId" | "lastThreadProvider"
  >,
  agent: "codex" | "pi",
): string | null {
  if (source.threadProvider === agent && source.threadId?.trim()) {
    return source.threadId.trim();
  }
  if (source.lastThreadProvider === agent && source.lastThreadId?.trim()) {
    return source.lastThreadId.trim();
  }
  return null;
}
