import type {
  AgentTeamAcceptanceCase,
  AgentTeamRun,
  AgentTeamWorker,
} from "@runweave/shared";

const ROLE_LABEL: Record<string, string> = {
  code: "code_agent（写代码）",
  code_review: "code_reviewer（审查）",
  behavior_verify: "behavior_verifier（按验收用例跑 Playwright）",
  plan: "plan_agent（形成计划）",
  plan_review: "plan_reviewer（审查计划）",
};

export function buildStartupPrompt(run: AgentTeamRun): string {
  return [
    "你现在是本终端里的主 Agent（agent-team / loop-engineer 流程）。",
    "",
    run.task ? `当前任务：${run.task}` : "先与人澄清需求意图。",
    "",
    "流程生命周期：需求澄清 clarify → 拆分提案 proposal → 执行观测 executing。",
    "- clarify：与人自由往返澄清意图，不做结构化约束。",
    "- 你可以在自判澄清充分时，主动通过 `POST /api/agent-team/runs/<runId>/propose-split` 产出拆分提案（相当于原型里的 rw propose-split）。",
    "- proposal：产出「开 N 个 worker + 各自意图」并草拟 markdown 验收用例，人确认后才 split pane。",
    "- executing：worker 在同一终端的 tmux pane 里跑；behavior_verify worker 按验收用例跑 Playwright，把 pass/fail + 证据写进 outbox。",
    "",
    "编排约束：",
    "- 你只负责编排：决定拆几个 worker、各自意图、验收用例；不亲自写代码或审查。",
    "- worker 之间零横向通信；失败用例由 backend（编排层）抛回对应 code pane。",
    "- loop 连续无进展会自动熔断升级人工；人接管后会带干预 note 恢复。",
  ].join("\n");
}

export function buildWorkerStartupPrompt(params: {
  run: AgentTeamRun;
  worker: AgentTeamWorker;
  acceptance: AgentTeamAcceptanceCase[];
}): string {
  const { run, worker, acceptance } = params;
  const lines = [
    `你是本 run 的 worker：${ROLE_LABEL[worker.role] ?? worker.role}。`,
    "",
    `Run: ${run.runId}`,
    `Role: ${worker.role}`,
    "",
    `意图：${worker.intent}`,
  ];
  if (worker.role === "behavior_verify") {
    lines.push(
      "",
      "验收用例（逐条跑 Playwright，产出 pass/fail + 截图/DOM 证据）：",
      ...acceptance.map((item, index) => `${index + 1}. [${item.caseId}] ${item.text}`),
      "",
      "把每条用例的结果写进 outbox 的 acceptanceResults：[{ caseId, status: pass|fail, evidence[] }]。",
    );
  }
  lines.push(
    "",
    "完成要求：",
    "- 只处理分配给你的意图，不接管主控调度。",
    "- 最终回复以结构化 summary 收尾（状态 / 结论 / 关键发现 / 产物 / 建议下一步）。",
  );
  return lines.join("\n");
}

/** Bounce a stable-failing acceptance case back to a code pane. */
export function buildBounceBackPrompt(params: {
  run: AgentTeamRun;
  failedCases: AgentTeamAcceptanceCase[];
}): string {
  const { run, failedCases } = params;
  return [
    `[loop round ${run.loop.round}] behavior_verify 连续多轮报以下用例失败，请修复：`,
    "",
    ...failedCases.map((item) => {
      const evidence = item.evidence
        .map((ev) => `${ev.type}:${ev.ref}`)
        .join("; ");
      return `- [${item.caseId}] ${item.text}${evidence ? `\n  证据：${evidence}` : ""}`;
    }),
    "",
    "修复后无需自己重跑验收；backend 会重新触发 behavior_verify。",
  ].join("\n");
}

export function buildHumanNotePrompt(note: string): string {
  return [
    "[人工干预] 主 Agent 请注意，人已介入本 run 并给出以下指引：",
    "",
    note,
    "",
    "loop 已重置（错误指纹 + 无进展计数清零），请据此调整后继续推进。",
  ].join("\n");
}
