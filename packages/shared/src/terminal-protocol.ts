export type TerminalRuntimePreference = "auto" | "tmux" | "pty";

export interface CreateTerminalSessionRequest {
  projectId?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  inheritFromTerminalSessionId?: string;
  runtimePreference?: TerminalRuntimePreference;
}

export interface CreateTerminalProjectRequest {
  name: string;
  path?: string | null;
}

export interface UpdateTerminalProjectRequest {
  name?: string;
  path?: string | null;
}

export interface TerminalProjectListItem {
  projectId: string;
  name: string;
  path: string | null;
  createdAt: string;
  isDefault: boolean;
}

export type TerminalPreviewChangeKind = "staged" | "working";
export type TerminalPreviewGitStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "unknown";

export type TerminalPreviewBase = "project" | "filesystem";

export interface TerminalPreviewFileSearchItem {
  path: string;
  basename: string;
  dirname: string;
  gitStatus?: TerminalPreviewGitStatus;
  reason: string;
  score: number;
}

export type TerminalPreviewQuickSearchMode = "files" | "content" | "folders";

export interface TerminalPreviewFolderSearchItem {
  path: string;
  basename: string;
  dirname: string;
  score: number;
}

export interface TerminalPreviewContentSearchRange {
  start: number;
  end: number;
}

export interface TerminalPreviewContentSearchItem {
  path: string;
  basename: string;
  dirname: string;
  line: number;
  column: number;
  lineText: string;
  ranges: TerminalPreviewContentSearchRange[];
}

export type TerminalPreviewTreeEntryKind = "directory" | "file";

export interface TerminalPreviewTreeEntry {
  kind: TerminalPreviewTreeEntryKind;
  path: string;
  basename: string;
  dirname: string;
  hasChildren?: boolean;
  sizeBytes?: number;
  mtimeMs?: number;
}

export interface TerminalPreviewDirectoryResponse {
  kind: "directory";
  projectId: string;
  projectPath: string;
  path: string;
  absolutePath: string;
  entries: TerminalPreviewTreeEntry[];
  limit: number;
  truncated: boolean;
}

export interface TerminalPreviewFileSearchResponse {
  kind: "file-search";
  projectId: string;
  projectPath: string;
  query: string;
  absoluteInput: boolean;
  items: TerminalPreviewFileSearchItem[];
}

export interface TerminalPreviewFolderSearchResponse {
  kind: "folder-search";
  projectId: string;
  projectPath: string;
  query: string;
  items: TerminalPreviewFolderSearchItem[];
  truncated: boolean;
}

export interface TerminalPreviewContentSearchResponse {
  kind: "content-search";
  projectId: string;
  projectPath: string;
  query: string;
  items: TerminalPreviewContentSearchItem[];
  truncated: boolean;
}

export interface TerminalPreviewFileResponse {
  kind: "file";
  projectId: string;
  path: string;
  absolutePath: string;
  base: TerminalPreviewBase;
  projectPath: string;
  language: string;
  content: string;
  sizeBytes: number;
  mtimeMs: number;
  readonly: boolean;
}

export interface TerminalPreviewSaveFileRequest {
  path: string;
  content: string;
  expectedMtimeMs: number;
  overwrite?: boolean;
}

export interface TerminalPreviewSaveFileResponse extends TerminalPreviewFileResponse {
  readonly: false;
}

export interface TerminalPreviewDeleteFileRequest {
  path: string;
  expectedMtimeMs?: number;
}

export interface TerminalPreviewDeleteFileResponse {
  kind: "file-delete";
  projectId: string;
  path: string;
  absolutePath: string;
}

export interface TerminalPreviewRenameFileRequest {
  path: string;
  nextPath: string;
  expectedMtimeMs?: number;
}

export interface TerminalPreviewResetChangeRequest {
  path: string;
  kind: TerminalPreviewChangeKind;
}

export interface TerminalPreviewResetChangeResponse {
  kind: "git-change-reset";
  projectId: string;
  path: string;
  changeKind: TerminalPreviewChangeKind;
}

export interface TerminalPreviewChangeFile {
  path: string;
  status: TerminalPreviewGitStatus;
}

export interface TerminalPreviewGitChangesResponse {
  kind: "git-changes";
  projectId: string;
  projectPath: string;
  repoRoot: string;
  staged: TerminalPreviewChangeFile[];
  working: TerminalPreviewChangeFile[];
}

export interface TerminalPreviewFileDiffResponse {
  kind: "file-diff";
  projectId: string;
  projectPath: string;
  repoRoot: string;
  changeKind: TerminalPreviewChangeKind;
  path: string;
  absolutePath: string;
  status: TerminalPreviewGitStatus;
  oldContent: string;
  newContent: string;
  readonly: true;
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
}

export type TerminalInputMode =
  | "raw"
  | "line"
  | "codex_slash_command"
  | "prompt_paste"
  | "tmux_exit_copy_mode";

export type TerminalQuickInputListKind = "recent" | "pinned" | "all";

export type TerminalQuickInputMode =
  | "line"
  | "codex_slash_command"
  | "prompt_paste";

export type TerminalQuickInputSource =
  | "web_terminal_quick_input"
  | "web_git_submit"
  | "web_browser_annotation"
  | "api_terminal_input";

export interface TerminalQuickInputItem {
  id: string;
  title: string;
  data: string;
  mode: TerminalQuickInputMode;
  projectId?: string | null;
  terminalSessionId?: string | null;
  cwd?: string | null;
  source: TerminalQuickInputSource;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  hiddenAt?: string | null;
  useCount: number;
}

export interface ListTerminalQuickInputsResponse {
  items: TerminalQuickInputItem[];
}

export interface CreateTerminalQuickInputRequest {
  title: string;
  data: string;
  mode: TerminalQuickInputMode;
  projectId?: string | null;
  terminalSessionId?: string | null;
  cwd?: string | null;
}

export interface UpdateTerminalQuickInputRequest {
  title?: string;
  pinned?: boolean;
}

export interface SendTerminalInputRequest {
  data: string;
  mode?: TerminalInputMode;
  operationId?: string;
  quickInputSource?: TerminalQuickInputSource;
  panelId?: string;
  panelAlias?: string;
  role?: TerminalPanelRole;
}

export interface SendTerminalInputResponse {
  operationId: string;
  terminalSessionId: string;
  inputAccepted: true;
  inputEnqueued: true;
  runtimeKind: "tmux" | "pty";
  acceptedAt: string;
}

export interface SendTerminalInterruptRequest {
  operationId?: string;
  panelId?: string;
  panelAlias?: string;
  role?: TerminalPanelRole;
}

export interface SendTerminalInterruptResponse
  extends SendTerminalInputResponse {
  interruptAccepted: true;
  interruptSequence: "escape";
}

export interface CreateTerminalClipboardImageRequest {
  mimeType: string;
  dataBase64: string;
}

export interface CreateTerminalClipboardImageResponse {
  fileName: string;
  filePath: string;
}

export interface TerminalSessionStatusResponse {
  terminalSessionId: string;
  projectId: string;
  alias?: string | null;
  threadId?: string;
  preview?: string;
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

export type TerminalPanelRole = string;

export const TERMINAL_PANEL_ROLE_SUGGESTIONS = [
  "main",
  "server",
  "tests",
  "planner",
  "reviewer",
  "worker",
] as const;

export interface TerminalPanelListItem {
  panelId: string;
  terminalSessionId: string;
  alias: string | null;
  role?: TerminalPanelRole | null;
  cwd: string;
  activeCommand: string | null;
  status: "running" | "exited";
  createdAt: string;
  lastActivityAt: string;
  exitCode?: number;
  focused: boolean;
  tmuxPaneId?: string;
}

export interface TerminalPanelWorkspace {
  terminalSessionId: string;
  activePanelId: string;
  panels: TerminalPanelListItem[];
  renderMode: "tmux-native";
}

export interface CreateTerminalPanelRequest {
  sourcePanelId?: string;
  direction: "right" | "down";
  alias?: string | null;
  role?: TerminalPanelRole | null;
  command?: string;
  args?: string[];
  cwd?: string;
  focus?: boolean;
}

export interface UpdateTerminalPanelRequest {
  focus?: boolean;
}

export interface AppHomeOverviewSession extends TerminalSessionListItem {
  title: string;
  subtitle: string;
  displayStatus: "running" | "agent-idle" | "idle" | "exited";
  displayStatusLabel:
    | "Agent Running"
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
  commandName: string | null;
  rawHookEvent: string | null;
  hookEvent: string;
  cwd: string | null;
  outboxPath?: string | null;
  summary?: string | null;
  panelId?: string | null;
  tmuxPaneId?: string | null;
}

export type TerminalAgentKind = "codex" | "trae" | "traex" | "traecli";

export type TerminalStateValue =
  | "shell_idle"
  | "agent_idle"
  | "agent_running";

export interface TerminalState {
  state: TerminalStateValue;
  agent: TerminalAgentKind | null;
}

export type TerminalStateChangeReason =
  | "agent_hook"
  | "metadata"
  | "interrupt"
  | "exit";

export interface TerminalStateChangedEventPayload {
  previous: TerminalState;
  next: TerminalState;
  reason: TerminalStateChangeReason;
}

export interface TerminalNotificationEventPayload {
  level: "info" | "success" | "warning" | "error";
  title: string;
  message?: string;
  source: "codex" | "terminal" | "system";
  dedupeKey?: string;
  action?: {
    type: "open_terminal";
    terminalSessionId: string;
  };
}

export interface TerminalProjectCreatedEventPayload {
  project: TerminalProjectListItem;
}

export interface TerminalSessionCreatedEventPayload {
  session: TerminalSessionListItem;
}

export interface TerminalProjectDeletedEventPayload {
  projectId: string;
  terminalSessionIds: string[];
}

export interface TerminalSessionDeletedEventPayload {
  terminalSessionId: string;
  projectId: string | null;
}

export interface TerminalPanelCreatedEventPayload {
  panel: TerminalPanelListItem;
  workspace: TerminalPanelWorkspace;
}

export interface TerminalPanelUpdatedEventPayload {
  panel: TerminalPanelListItem;
  workspace: TerminalPanelWorkspace;
}

export interface TerminalPanelDeletedEventPayload {
  terminalSessionId: string;
  panelId: string;
  workspace: TerminalPanelWorkspace;
}

export interface TerminalPanelFocusedEventPayload {
  terminalSessionId: string;
  panelId: string;
  alias: string | null;
  role?: string | null;
  source: "ui" | "cli" | "api" | "tmux";
  workspace: TerminalPanelWorkspace;
}

export interface TerminalPanelInputSentEventPayload {
  terminalSessionId: string;
  panelId: string;
  alias: string | null;
  role?: string | null;
  operationId: string;
  workspace: TerminalPanelWorkspace;
}

export type TerminalEventKind =
  | "completion"
  | "project_created"
  | "project_deleted"
  | "terminal_session_created"
  | "terminal_session_deleted"
  | "terminal_state_changed"
  | "terminal_notification"
  | "terminal_panel_created"
  | "terminal_panel_updated"
  | "terminal_panel_deleted"
  | "terminal_panel_focused"
  | "terminal_panel_input_sent";

interface TerminalEventEnvelopeBase {
  id: string;
  terminalSessionId: string | null;
  projectId: string | null;
  createdAt: string;
}

export type TerminalEventEnvelope =
  | (TerminalEventEnvelopeBase & {
      kind: "completion";
      terminalSessionId: string;
      payload: TerminalCompletionEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_state_changed";
      terminalSessionId: string;
      payload: TerminalStateChangedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_notification";
      terminalSessionId: string;
      payload: TerminalNotificationEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "project_created";
      terminalSessionId: null;
      projectId: string;
      payload: TerminalProjectCreatedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "project_deleted";
      terminalSessionId: null;
      projectId: string;
      payload: TerminalProjectDeletedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_session_created";
      terminalSessionId: string;
      projectId: string;
      payload: TerminalSessionCreatedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_session_deleted";
      terminalSessionId: string;
      projectId: string | null;
      payload: TerminalSessionDeletedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_panel_created";
      terminalSessionId: string;
      payload: TerminalPanelCreatedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_panel_updated";
      terminalSessionId: string;
      payload: TerminalPanelUpdatedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_panel_deleted";
      terminalSessionId: string;
      payload: TerminalPanelDeletedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_panel_focused";
      terminalSessionId: string;
      payload: TerminalPanelFocusedEventPayload;
    })
  | (TerminalEventEnvelopeBase & {
      kind: "terminal_panel_input_sent";
      terminalSessionId: string;
      payload: TerminalPanelInputSentEventPayload;
    });

export interface TerminalCompletionEventListResponse {
  events: TerminalEventEnvelope[];
}

export interface TerminalStateResponse {
  terminalState: TerminalState;
}

export type AgentHookStateEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "Stop";

export interface AgentHookStateRequest {
  terminalSessionId: string;
  projectId?: string;
  threadId?: string;
  agent: TerminalAgentKind;
  hookEvent: AgentHookStateEvent;
}

export type TerminalEventServerMessage =
  | {
      type: "connected";
      acceptedAfter: string | null;
    }
  | {
      type: "terminal-events";
      delivery: "catchup";
      events: TerminalEventEnvelope[];
    }
  | {
      type: "terminal-event";
      delivery: "live";
      event: TerminalEventEnvelope;
    }
  | {
      type: "error";
      message: string;
    };

export type TerminalSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export type TerminalClientMessage =
  | {
      type: "input";
      data: string;
    }
  | {
      type: "resize";
      cols: number;
      rows: number;
    }
  | {
      type: "signal";
      signal: TerminalSignal;
    }
  | {
      type: "request-status";
    };

export type TerminalServerMessage =
  | {
      type: "connected";
      terminalSessionId: string;
      runtimeKind?: "tmux" | "pty";
    }
  | {
      type: "snapshot";
      data: string;
    }
  | {
      type: "metadata";
      cwd: string;
      activeCommand: string | null;
    }
  | {
      type: "output";
      data: string;
    }
  | {
      type: "status";
      status: "running" | "exited";
      exitCode?: number;
    }
  | {
      type: "exit";
      exitCode: number | null;
    }
  | {
      type: "error";
      message: string;
    };
