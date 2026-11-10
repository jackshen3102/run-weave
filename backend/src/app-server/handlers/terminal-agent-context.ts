import type { TerminalCompletionEvent } from "@runweave/shared/terminal/completion";
import type { TerminalAgentKind } from "@runweave/shared/terminal/state";
import { getCompletionSourceForCommand } from "../../terminal/completion/source-gate";
import type { TerminalSessionManager } from "../../terminal/manager/manager";

const TERMINAL_AGENT_KINDS = new Set<TerminalAgentKind>([
  "codex", "trae", "traecli", "traex", "pi",
]);

export function resolveAppServerTerminalAgent(options: {
  terminalSessionManager: TerminalSessionManager;
  terminalSessionId: string;
  reportedSource: TerminalCompletionEvent["source"] | null;
  panelId: string | null;
  tmuxPaneId: string | null;
  commandName: string | null;
}): TerminalAgentKind | null {
  // Legacy Claude hooks have no verified process-generation/settled identity.
  // Never borrow the foreground Codex/Trae identity to make them actionable.
  if (options.reportedSource === "claude") return null;
  const source = getCompletionSourceForCommand(options.commandName);
  return source && TERMINAL_AGENT_KINDS.has(source as TerminalAgentKind)
    ? source as TerminalAgentKind : null;
}
