import type {
  RecoverTerminalAgentRequest,
  RecoverTerminalAgentResponse,
} from "@runweave/shared/terminal/agent-preparation";
import type {
  TerminalPanelRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager";
import { logger } from "../../logging";
import { getAgentForCommand } from "../terminal-state-service";
import { isInteractiveShellLaunch } from "../tmux-output-watcher-helpers";
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

  if (
    panel.terminalState?.state !== "agent_idle" ||
    panel.terminalState.agent !== "codex"
  ) {
    throw new TerminalPanelError(
      409,
      "Only an idle Codex panel can be recovered",
    );
  }
  if (!isInteractiveShellLaunch(session.command, session.args)) {
    throw new TerminalPanelError(
      409,
      "Terminal session command is not a persistent interactive shell",
    );
  }
  if (getAgentForCommand(panel.activeCommand) !== "codex") {
    throw new TerminalPanelError(409, "Terminal panel is not running Codex");
  }

  const resumedThreadId = resolveCodexThreadToRecover(
    terminalSessionManager,
    session,
    panel,
  );
  if (!resumedThreadId) {
    throw new TerminalPanelError(
      409,
      "Terminal panel has no saved Codex thread",
    );
  }

  agentRecoveryLogger.warn("terminal.agent-recovery.requested", {
    message: "Idle Codex panel recovery requested",
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
      agent: "codex",
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
    message: "Codex panel respawned and saved thread resume started",
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

function resolveCodexThreadToRecover(
  terminalSessionManager: TerminalSessionManager,
  session: TerminalSessionRecord,
  panel: TerminalPanelRecord,
): string | null {
  const panelThreadId = readCodexThreadId(panel);
  if (panelThreadId) {
    return panelThreadId;
  }
  const runningPanels = terminalSessionManager
    .listPanels(session.id)
    .filter((candidate) => candidate.status === "running");
  return runningPanels.length === 1 ? readCodexThreadId(session) : null;
}

function readCodexThreadId(
  source: Pick<
    TerminalPanelRecord | TerminalSessionRecord,
    "threadId" | "threadProvider" | "lastThreadId" | "lastThreadProvider"
  >,
): string | null {
  if (source.threadProvider === "codex" && source.threadId?.trim()) {
    return source.threadId.trim();
  }
  if (source.lastThreadProvider === "codex" && source.lastThreadId?.trim()) {
    return source.lastThreadId.trim();
  }
  return null;
}
