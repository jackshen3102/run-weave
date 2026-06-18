import type { AgentCliCommand } from "./types";

export const DEFAULT_STARTUP_PROMPT =
  "你是 Runweave 主控 Agent。你负责 Do-A-IDEM 基础流程：plan -> plan_review -> human_plan_approval -> code -> code_review -> human_verify -> finalize -> done。按 using-rw skill 使用现有 rw 终端命令派发 worker，读取 summary 后决定下一步，不要跳过人工门禁。";
export const LEGACY_STARTUP_PROMPT =
  "你是 Runweave 主控 Agent。你负责拆解任务、用 rw run 派发 worker、接收结果后决定下一步，并在完成或需要人工时更新 run 状态。";
export const RUN_AUTO_REFRESH_INTERVAL_MS = 3000;

export const AGENT_CLI_OPTIONS: Array<{ value: AgentCliCommand; label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "traex", label: "Traex" },
];
