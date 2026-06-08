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

export interface SendTerminalInputRequest {
  data: string;
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
  command: string;
  args: string[];
  cwd: string;
  activeCommand: string | null;
  tmuxSessionName?: string;
  tmuxSocketPath?: string;
  status: "running" | "exited";
  createdAt: string;
  lastActivityAt: string;
  exitCode?: number;
}

export interface TerminalMobileOverviewSession extends TerminalSessionListItem {
  title: string;
  subtitle: string;
  displayStatus: "running" | "idle" | "exited";
  displayStatusLabel: "Running" | "Idle" | "Exited";
  tailScrollback?: string;
  tailScrollbackSourceCols?: number;
  tailError?: string;
}

export interface TerminalMobileOverviewResponse {
  projects: TerminalProjectListItem[];
  sessions: TerminalMobileOverviewSession[];
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
  source: "claude" | "codex" | "trae" | "unknown";
  completionReason: TerminalCompletionReason;
  commandName: string | null;
  rawHookEvent: string | null;
  /** @deprecated Use rawHookEvent instead. Kept for short-term backward compatibility. */
  hookEvent: string;
  cwd: string | null;
  createdAt: string;
}

export interface TerminalCompletionEventListResponse {
  events: TerminalCompletionEvent[];
}

export type TerminalEventServerMessage =
  | {
      type: "connected";
      acceptedAfter: string | null;
    }
  | {
      type: "completion-events";
      delivery: "catchup";
      events: TerminalCompletionEvent[];
    }
  | {
      type: "completion-event";
      delivery: "live";
      event: TerminalCompletionEvent;
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
