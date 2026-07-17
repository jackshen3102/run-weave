import type { TerminalAgentKind } from "./state";

export type TerminalCompletionReason =
  | "hook_stop"
  | "notify"
  | "ai_process_exit"
  | "manual";

export interface TerminalCompletionEvent {
  id: string;
  terminalSessionId: string;
  projectId: string;
  source: "claude" | TerminalAgentKind | "unknown";
  completionReason: TerminalCompletionReason;
  commandName: string | null;
  rawHookEvent: string | null;
  /** @deprecated Use rawHookEvent instead. Kept for short-term backward compatibility. */
  hookEvent: string;
  cwd: string | null;
  outboxPath?: string | null;
  summary?: string | null;
  operationId?: string | null;
  /**
   * The panel (workspace pane) that produced the completion, when the terminal
   * session is split into multiple tmux panes. `null` for single-pane
   * terminals. Enables pane-as-worker attribution in the agent-team loop.
   */
  panelId?: string | null;
  /** The underlying tmux pane id (e.g. `%12`) for the completing pane, if known. */
  tmuxPaneId?: string | null;
  createdAt: string;
}

export interface TerminalCompletionEventPayload {
  source: TerminalCompletionEvent["source"];
  completionReason: TerminalCompletionReason;
  completionRevision: number;
  commandName: string | null;
  rawHookEvent: string | null;
  hookEvent: string;
  cwd: string | null;
  outboxPath?: string | null;
  summary?: string | null;
  operationId?: string | null;
  panelId?: string | null;
  tmuxPaneId?: string | null;
}
