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
    "- 你只负责编排：决定下一步派谁、给什么 goal，不亲自写代码或做审查。",
    "- plan 阶段由你负责形成计划；用 write-plan 技能产出计划文件，再派发 plan_reviewer 审查。",
    "- plan_reviewer、code_agent、code_reviewer 都是黑盒 worker，只消费它们回传的结构化 summary。",
    "- human_plan_approval 和 human_verify 是人工门禁；不要跳过人工验收进入 finalize。",
    "- human_verify 通过后才进入 finalize；finalize 里完成提交、提交结果记录和 done 收尾。",
    run.options?.requireHumanConfirmationEachRound
      ? "- 当前 run 已开启“每一轮都需要人工确认”；worker result 回来后，如果下一阶段不是既有人工门禁，backend 会先暂停等待人工确认。"
      : null,
    "",
    "调度方式：",
    "- 把 worker 当成异步任务。派发任务后不要长时间轮询 worker 终端，也不要写 while/for sleep 循环等待。",
    "- 使用 using-rw 技能按上面的角色和终端映射派发 worker，发送简洁的 worker prompt。",
    `- 每个 worker prompt 开头必须包含三行路由信息：\`Run: ${run.runId}\`、\`Role: <roleId>\`、\`Goal: <goalId>\`。Role 必须是 plan_reviewer、code_agent 或 code_reviewer；Goal 由你为本次派发生成并保持唯一。`,
    "- worker 完成后会通过 completion hook / outbox 回传 summary，Runweave backend 会把结果重新注入给你。",
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
  const skill = params.role.skill?.trim();
  return [
    params.role.prompt.trim(),
    ...(skill ? ["", `使用 ${skill} 技能完成本次任务。`] : []),
    "",
    `Run: ${params.run.runId}`,
    `Role: ${params.role.id}`,
    `Task: ${params.run.task}`,
    `Goal: ${params.goalId}`,
    "",
    "完成要求：",
    "- 只处理这个 goal，不要接管主控调度。",
    "- 如果无法完成，状态用 failed 或 need_human，并说明原因和仍需人工确认的信息。",
    "- completion hook 会把你的最终回复回传给主控 Agent，所以最终回复必须以下面的结构化 summary 收尾：",
    "  状态: passed / changes_requested / failed / need_human",
    "  结论: <一句话总体结论>",
    "  关键发现: <审查类列 P0/P1 条目；执行类列改动清单>",
    "  产物: <相关文件或 plan 路径，没有则写 none>",
    "  建议下一步: <给主控 Agent 的下一步提示>",
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
