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

export type TerminalPrototypeGalleryProjectStatus =
  | "available"
  | "project-path-missing"
  | "prototype-root-missing"
  | "prototype-root-unavailable";

export type TerminalPrototypeGallerySource =
  | "prototypes"
  | "architecture-flows";

export interface TerminalPrototypeGalleryItem {
  projectId: string;
  source: TerminalPrototypeGallerySource;
  slug: string;
  title: string;
  entry: "index.html" | null;
  files: string[];
}

export interface TerminalPrototypeGalleryProject {
  projectId: string;
  name: string;
  path: string | null;
  status: TerminalPrototypeGalleryProjectStatus;
  prototypes: TerminalPrototypeGalleryItem[];
}

export interface TerminalPrototypeGalleryResponse {
  projects: TerminalPrototypeGalleryProject[];
}

export interface CreateTerminalPrototypePreviewTicketResponse {
  path: string;
  expiresIn: number;
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
