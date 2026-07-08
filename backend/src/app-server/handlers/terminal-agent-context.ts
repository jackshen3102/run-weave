import type {
  TerminalAgentKind,
  TerminalCompletionEvent,
} from "@runweave/shared";
import { getCompletionSourceForCommand } from "../../terminal/completion-source-gate";
import type {
  TerminalPanelRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../../terminal/manager";
import { getAgentForCommand } from "../../terminal/terminal-state-service";

const TERMINAL_AGENT_KINDS = new Set<TerminalAgentKind>([
  "codex",
  "trae",
  "traecli",
  "traex",
]);

export function resolveAppServerTerminalAgent(options: {
  terminalSessionManager: TerminalSessionManager;
  terminalSessionId: string;
  reportedSource: TerminalCompletionEvent["source"] | null;
  panelId: string | null;
  tmuxPaneId: string | null;
  commandName: string | null;
}): TerminalAgentKind | null {
  const commandSource = getCompletionSourceForCommand(options.commandName);
  if (isTerminalAgentKind(commandSource)) {
    return commandSource;
  }

  if (options.reportedSource !== "claude") {
    return null;
  }

  const session = options.terminalSessionManager.getSession(
    options.terminalSessionId,
  );
  if (!session) {
    return null;
  }
  const panel = resolvePanel({
    terminalSessionManager: options.terminalSessionManager,
    terminalSessionId: options.terminalSessionId,
    panelId: options.panelId,
    tmuxPaneId: options.tmuxPaneId,
  });

  return getRecordAgent(panel) ?? getRecordAgent(session);
}

function resolvePanel(options: {
  terminalSessionManager: TerminalSessionManager;
  terminalSessionId: string;
  panelId: string | null;
  tmuxPaneId: string | null;
}): TerminalPanelRecord | null {
  if (options.panelId) {
    const panel = options.terminalSessionManager.getPanel(options.panelId);
    return panel?.terminalSessionId === options.terminalSessionId ? panel : null;
  }
  if (!options.tmuxPaneId) {
    return null;
  }
  return (
    options.terminalSessionManager
      .listPanels(options.terminalSessionId)
      .find((panel) => panel.tmuxPaneId === options.tmuxPaneId) ?? null
  );
}

function getRecordAgent(
  record: Pick<TerminalSessionRecord, "activeCommand" | "terminalState"> | null,
): TerminalAgentKind | null {
  const storedAgent = record?.terminalState?.agent ?? null;
  if (isTerminalAgentKind(storedAgent)) {
    return storedAgent;
  }
  const activeCommandAgent = getAgentForCommand(record?.activeCommand ?? null);
  return isTerminalAgentKind(activeCommandAgent) ? activeCommandAgent : null;
}

function isTerminalAgentKind(
  value: TerminalCompletionEvent["source"] | TerminalAgentKind | null,
): value is TerminalAgentKind {
  return Boolean(value && TERMINAL_AGENT_KINDS.has(value as TerminalAgentKind));
}
