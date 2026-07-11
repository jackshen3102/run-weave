import type { TerminalProjectListItem } from "./project";
import type { TerminalState } from "./state";

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
  terminalSessionId: string;
  projectId: string;
  alias?: string | null;
  threadId?: string;
  preview?: string;
  lastThreadId?: string;
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
  terminalSessionId: string;
  projectId: string;
  alias?: string | null;
  threadId?: string;
  preview?: string;
  lastThreadId?: string;
  lastThreadStatus?: TerminalLastThreadStatus;
  lastThreadUpdatedAt?: string;
  command: string;
  args: string[];
  cwd: string;
  activeCommand: string | null;
  terminalState?: TerminalState;
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

export interface UpdateTerminalSessionRequest {
  alias?: string | null;
  panelSplitEnabled?: boolean;
}
