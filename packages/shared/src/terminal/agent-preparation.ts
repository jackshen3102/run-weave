import type { TerminalAgentKind } from "./state";

export type TerminalAgentPreparationAgent = "codex" | "traex";

export const DEFAULT_TERMINAL_AGENT_BOOTSTRAP_PROMPT =
  "只读回答当前工作目录的绝对路径，不运行后台任务、不修改任何文件；完成后等待下一条输入。";

export interface PrepareTerminalAgentRequest {
  agent: TerminalAgentPreparationAgent;
  prompt: string;
  panelId?: string;
  cwd?: string;
  role?: string | null;
  alias?: string | null;
  sourcePanelId?: string;
  direction?: "right" | "down";
  focus?: boolean;
  command?: string;
  commandLine?: string;
  args?: string[];
  timeoutMs?: number;
}

export interface PrepareTerminalAgentResponse {
  operationId: string;
  terminalSessionId: string;
  panelId: string;
  tmuxPaneId: string;
  provider: TerminalAgentKind;
  threadId: string | null;
  status: "starting";
  createdPanel: boolean;
  startedAt: string;
}

export type TerminalAgentPreparationFailurePhase =
  | "panel_create"
  | "cli_launch"
  | "lifecycle_timeout"
  | "cli_exit";

export interface TerminalAgentPreparationFailureDetails {
  phase: TerminalAgentPreparationFailurePhase;
  operationId: string;
  terminalSessionId: string;
  panelId: string | null;
  tmuxPaneId: string | null;
  createdPanel: boolean;
  provider: TerminalAgentPreparationAgent;
  exitCode?: number;
}
