export interface CreateTerminalSessionRequest {
  projectId?: string;
  name?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  inheritFromTerminalSessionId?: string;
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

export interface TerminalPreviewFileSearchItem {
  path: string;
  basename: string;
  dirname: string;
  gitStatus?: TerminalPreviewGitStatus;
  reason: string;
  score: number;
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
  base: "project";
  projectPath: string;
  language: string;
  content: string;
  sizeBytes: number;
  readonly: true;
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
  name: string;
  command: string;
  args: string[];
  cwd: string;
  scrollback: string;
  status: "running" | "exited";
  createdAt: string;
  exitCode?: number;
}

export type TerminalSessionHistoryResponse = TerminalSessionStatusResponse;

export interface TerminalSessionListItem {
  terminalSessionId: string;
  projectId: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  status: "running" | "exited";
  createdAt: string;
  exitCode?: number;
}

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
    }
  | {
      type: "snapshot";
      data: string;
    }
  | {
      type: "metadata";
      name: string;
      cwd: string;
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
