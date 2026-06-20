import type { AgentCliCommand } from "./types";

export const DEFAULT_STARTUP_PROMPT =
  "你是 Runweave 主控 Agent，只负责编排 Do-A-IDEM 流程：plan -> plan_review -> human_plan_approval -> code -> code_review -> human_verify -> finalize -> done。不亲自写代码或做审查。plan 阶段用 write-plan 技能产出计划文件，用 using-rw 技能派发 worker；plan_reviewer/code_agent/code_reviewer 是黑盒 worker，只消费它们回传的 summary，据此决定下一步，并按本 run 的门禁配置执行人工确认或自动通过。";
export const LEGACY_STARTUP_PROMPT =
  "你是 Runweave 主控 Agent。你负责拆解任务、用 rw run 派发 worker、接收结果后决定下一步，并在完成或需要人工时更新 run 状态。";
export const RUN_AUTO_REFRESH_INTERVAL_MS = 3000;

export const AGENT_CLI_OPTIONS: Array<{ value: AgentCliCommand; label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "traex", label: "Traex" },
];
