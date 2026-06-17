import path from "node:path";
import type {
  OrchestratorRunPackage,
  OrchestratorRunRole,
  OrchestratorWorkerOutbox,
} from "@runweave/shared";
import type { TerminalSessionRecord } from "../../terminal/manager";

export type AgentCliCommand = "codex" | "traex";

export function buildStartupPrompt(
  run: OrchestratorRunPackage,
  startupPrompt: string,
  roleTerminalMappings: string[],
  controlPlaneBaseUrl: string | null,
): string {
  return [
    startupPrompt.trim(),
    "",
    `当前任务：${run.task}`,
    "",
    ...formatControlPlanePromptLines(controlPlaneBaseUrl),
    "",
    "角色和终端映射：",
    ...roleTerminalMappings.map((item) => `- ${item}`),
    "",
    "Do-A-IDEM 基础流程：",
    "- 固定阶段：discuss -> plan -> plan_review -> human_plan_approval -> code -> code_review -> human_verify -> finalize -> done。",
    "- Plan 阶段由你负责形成计划；需要审查时派发 plan_reviewer。",
    "- plan_reviewer、code_agent、code_reviewer 都是黑盒 worker，只消费它们回传的 summary。",
    "- human_plan_approval 和 human_verify 是人工门禁；不要跳过人工验收进入 finalize。",
    "- human_verify 通过后才进入 finalize；finalize 里完成提交、提交结果记录和 done 收尾。",
    run.options?.requireHumanConfirmationEachRound
      ? "- 当前 run 已开启“每一轮都需要人工确认”；worker result 回来后，如果下一阶段不是既有人工门禁，backend 会先暂停等待人工确认。"
      : null,
    "",
    "调度方式：",
    "- 把 worker 当成异步任务。派发任务后不要长时间轮询 worker 终端，也不要写 while/for sleep 循环等待半小时或更久。",
    "- 使用 using-rw skill 和现有 `rw terminal` 命令创建或复用 worker 终端，并用 `rw terminal send --agent <codex|traex>` 发送简洁的 worker prompt。",
    "- 不要手动向 shell 发送 `codex` 或 `traex` 来启动 worker；`rw terminal send --agent` 会在终端没有 agent 时自动启动目标 agent。",
    "- 如果目标终端已经运行了不同 agent，默认不要覆盖；只有明确需要替换时，才使用 `--agent-overwrite`。",
    "- 发送成功只代表 backend 接收了输入；最多做一次短确认，确认消息已进入目标终端即可。",
    "- worker 完成后会通过已有 completion hook / outbox 回传结果，Runweave backend 会把结果重新注入给你。",
    "- 收到 worker result 注入后，再决定下一步：继续派发、报告 failed，或等待人工门禁。",
    "- 不要依赖专用 orchestrator CLI 命令；Runweave backend 会根据固定 Do-A-IDEM 事件推进 currentPhase。",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function buildWorkerPrompt(params: {
  run: OrchestratorRunPackage;
  role: OrchestratorRunRole;
  goalId: string;
  query: string;
}): string {
  return [
    params.role.prompt.trim(),
    "",
    `Run: ${params.run.runId}`,
    `Role: ${params.role.id}`,
    `Task: ${params.run.task}`,
    `Goal: ${params.goalId}`,
    "",
    "完成要求：",
    "- 只处理这个 goal，不要接管主控调度。",
    "- 完成后直接给出结果摘要、状态和必要产物路径；completion hook 会把你的最终回复回传给主控 Agent。",
    "- 如果无法完成，说明失败原因和仍需人工确认的信息。",
    "",
    params.query.trim(),
  ].join("\n");
}

export function buildResultPrompt(outbox: OrchestratorWorkerOutbox): string {
  const artifacts = outbox.artifacts.map((item) => item.path).join(", ") || "none";
  return [
    `Worker result received for goal ${outbox.goalId ?? "unknown"} / role ${outbox.role ?? "unknown"}.`,
    `Status: ${outbox.status}`,
    `Worker terminal: ${outbox.sessionId}`,
    `Artifacts: ${artifacts}`,
    "",
    outbox.summary,
    "",
    "Decide the next step now. If another worker is needed, dispatch it asynchronously with existing `rw terminal` commands.",
    "Do not long-poll worker terminals. Wait for the backend to inject the next worker result, or report done, failed, or need_human.",
  ].join("\n");
}

export function buildHumanPrompt(text: string): string {
  return [`Human instruction for this Runweave orchestrator run:`, "", text].join("\n");
}

export function formatTerminalLabel(
  session: Pick<TerminalSessionRecord, "alias" | "cwd" | "activeCommand" | "command">,
): string {
  const base = session.alias?.trim() || path.basename(session.cwd) || session.cwd;
  const command = session.activeCommand?.trim() || session.command.trim();
  return command ? `${base}(${command})` : base;
}

export function resolveAgentCliCommand(command: string | undefined): AgentCliCommand {
  return command?.trim() === "traex" ? "traex" : "codex";
}

export function normalizeBaseUrl(baseUrl: string | null | undefined): string | null {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "");
}

function formatControlPlanePromptLines(baseUrl: string | null): string[] {
  if (!baseUrl) {
    return [];
  }
  return [
    "Runweave 控制面连接：",
    `- 当前后端地址是 ${baseUrl}`,
    `- 执行 rw 命令时必须使用这个地址，例如先运行：export RUNWEAVE_BASE_URL=${shellQuote(baseUrl)}`,
    "- 不要使用 using-rw skill 里的默认 5001，除非这里明确给出的地址也是 5001。",
  ];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
