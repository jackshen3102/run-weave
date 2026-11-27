import type { TerminalProjectListItem } from "../project";
import type { ScheduledTaskSource } from "../../scheduled-tasks/types";
import type { TerminalAgentKind, TerminalState } from "./state";
import type { TerminalAgentRecoveryTarget } from "./agent-preparation";
import type { TerminalProgramStatus } from "./program-status";

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

/** Current backend-owned identity for tools launched before a terminal was moved. */
export interface TerminalSessionIdentityResponse {
  terminalSessionId: string;
  projectId: string;
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

export interface TerminalSessionStatusQuery {
  /** Defaults to true. False returns metadata with empty scrollback, without reading live history. */
  includeScrollback?: boolean;
}

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

export interface TerminalAnsiScrollbackResponse {
  terminalSessionId: string;
  /** 当前抓取对应的真实 tmux pane 标识（如 "%0"），用于客户端防串屏校验。 */
  paneId: string;
  /** 服务端抓取时的 pane 列宽，供诊断记录。 */
  sourceCols: number;
  /** 实际返回的逻辑行数（上限 5000）。 */
  lineCount: number;
  /** 经 capture-pane -e -J -p 抓取并按完整行裁剪至 <= 1 MiB UTF-8 的带 ANSI 样式文本。 */
  data: string;
}

export interface TerminalSessionListItem {
  /** Explicit restore target approved by this Backend; not a current Agent binding. */
  agentRecovery?: TerminalAgentRecoveryTarget;
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
  programStatus?: TerminalProgramStatus;
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
  conversationPreview?: import("../../app-server/thread-preview").AppServerThreadPreview;
  /** Active panel/provider/thread identity used to reject stale asynchronous previews. */
  conversationKey?: string | null;
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

export interface AppHomeConversationPreviewsResponse {
  sessions: Array<{
    terminalSessionId: string;
    conversationKey: string;
    conversationPreview: import("../../app-server/thread-preview").AppServerThreadPreview;
  }>;
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
  /** Move to an existing primary project; preserves cwd, process and panels. Send alone. */
  projectId?: string;
  pinned?: boolean;
  alias?: string | null;
  panelSplitEnabled?: boolean;
  acknowledgedCompletionRevision?: number;
}
