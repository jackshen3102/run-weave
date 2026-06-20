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

export interface SendTerminalInputRequest {
  data: string;
  mode?: TerminalInputMode;
  operationId?: string;
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

export type TerminalEventKind =
  | "completion"
  | "project_created"
  | "project_deleted"
  | "terminal_session_created"
  | "terminal_session_deleted"
  | "terminal_state_changed"
  | "terminal_notification";

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
