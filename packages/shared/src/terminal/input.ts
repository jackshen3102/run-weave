import type { TerminalPanelRole } from "./panel";

export type TerminalInputMode =
  | "raw"
  | "line"
  | "codex_slash_command"
  | "prompt_paste"
  | "prompt_replace"
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
  submit?: boolean;
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
