import type { TerminalPanelRole } from "../panel";

export type TerminalInputMode =
  | "raw"
  | "line"
  | "codex_slash_command"
  | "prompt_paste"
  | "prompt_replace"
  | "tmux_exit_copy_mode";

export type TerminalPromptSubmitKey = "Enter" | "Tab" | "M-Enter";

export type TerminalQuickInputListKind = "recent" | "pinned" | "all";

export type TerminalQuickInputMode =
  | "line"
  | "codex_slash_command"
  | "prompt_paste";

export type TerminalQuickInputSource =
  | "web_terminal_quick_input"
  | "web_git_submit"
  | "web_browser_annotation"
  | "api_terminal_input"
  | "ios_quick_reply";

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
  manualOrder?: number;
  clientImportId?: string;
}

export interface ListTerminalQuickInputsResponse {
  items: TerminalQuickInputItem[];
  nextCursor?: string | null;
  orderVersion?: string;
}

export interface CreateTerminalQuickInputRequest {
  title: string;
  data: string;
  mode: TerminalQuickInputMode;
  projectId?: string | null;
  terminalSessionId?: string | null;
  cwd?: string | null;
  source?: "ios_quick_reply";
  clientImportId?: string;
}

export interface UpdateTerminalQuickInputRequest {
  title?: string;
  pinned?: boolean;
  data?: string;
  mode?: TerminalQuickInputMode;
  expectedUpdatedAt?: string;
}

export interface SendTerminalInputRequest {
  data: string;
  /** Reject handoff input when the Codex thread is no longer idle or has changed. */
  expectedThreadId?: string;
  mode?: TerminalInputMode;
  submit?: boolean;
  /** Native key for prompt_replace with submit=true; defaults to Enter. */
  submitKey?: TerminalPromptSubmitKey;
  operationId?: string;
  quickInputSource?: TerminalQuickInputSource;
  /** false skips quick-input history; omitted or true preserves existing recording. */
  recordQuickInput?: boolean;
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

export interface SendTerminalInterruptResponse extends SendTerminalInputResponse {
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
