import type { TerminalProjectListItem } from "../project";
import type { ScheduledTaskSource } from "../../scheduled-tasks/types";
import type { TerminalAgentKind, TerminalState } from "./state";

export type TerminalRuntimePreference = "auto" | "tmux" | "pty";

export interface CreateTerminalSessionRequest {
  projectId?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  inheritFromTerminalSessionId?: string;
  runtimePreference?: TerminalRuntimePreference;
}

export interface CreateTerminalSessionResponse {
  terminalSessionId: string;
  terminalUrl: string;
}

export interface CreateTerminalWsTicketResponse {
  ticket: string;
  expiresIn: number;
}

export interface CreateTerminalEventsWsTicketResponse {
  ticket: string;
  expiresIn: number;
  baselineEventId: string | null;
  streamId: string;
}

export type TerminalLastThreadStatus = "idle" | "running";

export interface TerminalSessionStatusResponse {
  source?: ScheduledTaskSource;
  terminalSessionId: string;
  projectId: string;
  alias?: string | null;
  threadId?: string;
  threadProvider?: TerminalAgentKind;
  preview?: string;
  lastThreadId?: string;
  lastThreadProvider?: TerminalAgentKind;
  lastThreadStatus?: TerminalLastThreadStatus;
  lastThreadUpdatedAt?: string;
  command: string;
  args: string[];
  cwd: string;
  activeCommand: string | null;
  tmuxSessionName?: string;
  tmuxSocketPath?: string;
  scrollback: string;
  scrollbackSourceCols?: number;
  status: "running" | "exited";
  createdAt: string;
  lastActivityAt: string;
  exitCode?: number;
}

export type TerminalSessionHistoryResponse = TerminalSessionStatusResponse;

export interface TerminalSessionListItem {
  source?: ScheduledTaskSource;
  /** Backend-generated UTC timestamp; missing/null means unpinned. */
  pinnedAt?: string | null;
  terminalSessionId: string;
  projectId: string;
  alias?: string | null;
  threadId?: string;
  threadProvider?: TerminalAgentKind;
  preview?: string;
  lastThreadId?: string;
  lastThreadProvider?: TerminalAgentKind;
  lastThreadStatus?: TerminalLastThreadStatus;
  lastThreadUpdatedAt?: string;
  command: string;
  args: string[];
  cwd: string;
  activeCommand: string | null;
  terminalState?: TerminalState;
  completionRevision: number;
  acknowledgedCompletionRevision: number;
  tmuxSessionName?: string;
  tmuxSocketPath?: string;
  status: "running" | "exited";
  createdAt: string;
  lastActivityAt: string;
  exitCode?: number;
  panelSplitEnabled: boolean;
  activePanelId?: string;
  panelCount?: number;
  panelAliases?: string[];
}

export interface AppHomeOverviewSession extends TerminalSessionListItem {
  title: string;
  /** Latest completed reply as a plain-text preview; falls back to cwd. */
  subtitle: string;
  displayStatus:
    | "running"
    | "agent-starting"
    | "agent-idle"
    | "idle"
    | "exited";
  displayStatusLabel:
    | "Agent Running"
    | "Agent Starting"
    | "Agent Idle"
    | "Running"
    | "Idle"
    | "Exited";
  terminalState: TerminalState;
}

export interface AppHomeOverviewResponse {
  projects: TerminalProjectListItem[];
  sessions: AppHomeOverviewSession[];
}

/** Separate from overview: fetching Git must never delay the terminal list. */
export interface AppHomeBranchStatusRequest {
  terminalSessionIds: string[];
  refresh?: boolean;
}

export interface AppHomeBranchStatus {
  terminalSessionId: string;
  cwd: string;
  state: "ready" | "stale" | "unavailable" | "not-repository";
  /** Remote default branch name, never the feature branch's upstream. */
  baseBranch?: string;
  behind?: number;
  /** Last successful remote update and comparison (UTC). Absent when unknown. */
  checkedAt?: string;
}

export interface AppHomeBranchStatusResponse {
  statuses: AppHomeBranchStatus[];
}

export interface UpdateTerminalSessionRequest {
  pinned?: boolean;
  alias?: string | null;
  panelSplitEnabled?: boolean;
  acknowledgedCompletionRevision?: number;
}
