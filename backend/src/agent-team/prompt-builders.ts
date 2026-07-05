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
const EVIDENCE_SCHEMA =
  'acceptanceResults[].evidence[] 必须使用 { type, label, summary, ref, detail? }；type 可用 "text"、"dom"、"screenshot"、"command"、"event"、"json"、"log"、"code"。label 是短标题，summary 是给人看的单句结论，ref 保留原始证据路径、文本或标识。';

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
  outboxPath?: string | null;
}): string {
  const { run, worker, acceptance, outboxPath } = params;
  const lines = [
    `你是本 run 的 worker：${ROLE_LABEL[worker.role] ?? worker.role}。`,
    "",
    `Run: ${run.runId}`,
    `Role: ${worker.role}`,
    `Session: ${run.terminalSessionId}`,
    `PanelId: ${worker.panelId ?? ""}`,
    `TmuxPaneId: ${worker.tmuxPaneId ?? ""}`,
    "",
    `意图：${worker.intent}`,
  ];
  if (worker.role === "behavior_verify") {
    lines.push(
      "",
      "验收用例（逐条跑 Playwright，产出 pass/fail + 截图/DOM 证据）：",
      ...acceptance.map((item, index) => `${index + 1}. [${item.caseId}] ${item.text}`),
      "",
      outboxPath
        ? `把每条用例的结果写进 ${outboxPath} 的 acceptanceResults：[{ caseId, status: pass|fail, evidence[] }]。`
        : "把每条用例的结果写进 outbox 的 acceptanceResults：[{ caseId, status: pass|fail, evidence[] }]。",
    );
  } else if (worker.role === "code_review" || worker.role === "plan_review") {
    lines.push(
      "",
      "审查用例（发现 P0/P1/blocker/critical 时必须写 fail；无阻断问题写 pass）：",
      ...acceptance.map((item, index) => `${index + 1}. [${item.caseId}] ${item.text}`),
      "",
      outboxPath
        ? `把审查门禁结果写进 ${outboxPath} 的 acceptanceResults。优先使用 Code Review/代码审查相关 caseId；如果没有，使用最相关的 caseId。`
        : "把审查门禁结果写进 outbox 的 acceptanceResults。优先使用 Code Review/代码审查相关 caseId；如果没有，使用最相关的 caseId。",
    );
  }
  lines.push(
    "",
    "完成要求：",
    "- 只处理分配给你的意图，不接管主控调度。",
    ...(outboxPath
      ? [
          `- 本 worker 的结构化 outbox 固定写入：${outboxPath}。不要写 session 级 .runweave/outbox/${run.terminalSessionId}.json，避免同一 terminal 多 pane 覆盖。`,
          `- outbox 顶层必须包含：sessionId="${run.terminalSessionId}"、panelId="${worker.panelId ?? ""}"、tmuxPaneId="${worker.tmuxPaneId ?? ""}"、runId="${run.runId}"、role="${worker.role}"、status="completed"|"failed"、summary、error、finishedAt。`,
          `- ${EVIDENCE_SCHEMA}`,
        ]
      : []),
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
        .map((ev) => `${ev.label}: ${ev.summary}`)
        .join("; ");
      return `- [${item.caseId}] ${item.text}${evidence ? `\n  证据：${evidence}` : ""}`;
    }),
    "",
    "修复后无需自己重跑验收；backend 会重新触发 behavior_verify。",
  ].join("\n");
}

/** Ask a review/verify worker to rerun cases after a code pane completed fixes. */
export function buildWorkerRecheckPrompt(params: {
  run: AgentTeamRun;
  worker: AgentTeamWorker;
  cases: AgentTeamAcceptanceCase[];
  outboxPath?: string | null;
}): string {
  const { run, worker, cases, outboxPath } = params;
  const isReviewWorker =
    worker.role === "code_review" || worker.role === "plan_review";
  return [
    `[loop round ${run.loop.round}] code pane 已完成修复，请重新${isReviewWorker ? "审查" : "验收"}以下用例：`,
    "",
    ...cases.map((item) => `- [${item.caseId}] ${item.text}`),
    "",
    outboxPath
      ? `把结果写进 ${outboxPath} 的 acceptanceResults：[{ caseId, status: pass|fail, evidence[] }]。`
      : "把结果写进 outbox 的 acceptanceResults：[{ caseId, status: pass|fail, evidence[] }]。",
    ...(outboxPath
      ? [
          `outbox 顶层必须包含：sessionId="${run.terminalSessionId}"、panelId="${worker.panelId ?? ""}"、tmuxPaneId="${worker.tmuxPaneId ?? ""}"、runId="${run.runId}"、role="${worker.role}"、status="completed"|"failed"、summary、error、finishedAt。`,
          EVIDENCE_SCHEMA,
        ]
      : []),
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
