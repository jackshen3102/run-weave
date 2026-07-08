import type {
  AgentTeamAcceptanceCase,
  AgentTeamRun,
  AgentTeamWorker,
} from "@runweave/shared";

const ROLE_LABEL: Record<string, string> = {
  code: "code_agent（写代码）",
  code_review: "code_reviewer（审查）",
  behavior_verify: "behavior_verifier（按验收用例跑 Playwright）",
};
const EVIDENCE_SCHEMA =
  'acceptanceResults[].evidence[] 必须使用 { type, label, summary, ref, detail? }；type 可用 "text"、"dom"、"screenshot"、"command"、"event"、"json"、"log"、"code"。label 是短标题，summary 是给人看的单句结论，ref 保留原始证据路径、文本或标识。';
const FINDING_SCHEMA =
  '审查类 outbox 如有发现，必须用 remainingFindings / resolvedFindings 表达：仍存在的问题写 remainingFindings，已修复的问题写 resolvedFindings；字段为 { severity: "P0"|"P1"|"P2"|"P3", status?: "open"|"resolved"|"informational", title, summary, ref? }。acceptanceResults 为 pass 时，summary 不要留下未修复 P0/P1 的暗示。';

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
  } else if (worker.role === "code_review") {
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
          ...(worker.role === "code_review" ? [`- ${FINDING_SCHEMA}`] : []),
        ]
      : []),
    "- 最终回复以结构化 summary 收尾（状态 / 结论 / 关键发现 / 产物 / 建议下一步）。",
  );
  return lines.join("\n");
}

/** Bounce a failed gate case back to a code pane. */
export function buildBounceBackPrompt(params: {
  run: AgentTeamRun;
  failedCases: AgentTeamAcceptanceCase[];
}): string {
  const { run, failedCases } = params;
  const isReviewGateBounce =
    failedCases.length > 0 && failedCases.every(isReviewGateAcceptanceCase);
  return [
    isReviewGateBounce
      ? `[loop round ${run.loop.round}] 串行门禁报以下用例失败，请修复：`
      : `[loop round ${run.loop.round}] behavior_verify 连续多轮报以下用例失败，请修复：`,
    "",
    ...failedCases.map((item) => {
      const evidence = item.evidence
        .map((ev) => `${ev.label}: ${ev.summary}`)
        .join("; ");
      return `- [${item.caseId}] ${item.text}${evidence ? `\n  证据：${evidence}` : ""}`;
    }),
    "",
    isReviewGateBounce
      ? "修复后无需自己重跑审查或验收；backend 会按 code_review → behavior_verify 顺序重新触发。"
      : "修复后无需自己重跑验收；backend 会重新触发 behavior_verify。",
  ].join("\n");
}

function isReviewGateAcceptanceCase(item: AgentTeamAcceptanceCase): boolean {
  return /code review|代码审查|code_review/i.test(item.text);
}

/** Ask a review/verify worker to rerun cases after a code pane completed fixes. */
export function buildWorkerRecheckPrompt(params: {
  run: AgentTeamRun;
  worker: AgentTeamWorker;
  cases: AgentTeamAcceptanceCase[];
  outboxPath?: string | null;
}): string {
  const { run, worker, cases, outboxPath } = params;
  const isReviewWorker = worker.role === "code_review";
  const sourceLabel =
    worker.role === "behavior_verify" ? "code_review" : "code pane";
  return [
    `[loop round ${run.loop.round}] ${sourceLabel} 已完成修复，请重新${isReviewWorker ? "审查" : "验收"}以下用例：`,
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
          ...(isReviewWorker ? [FINDING_SCHEMA] : []),
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
