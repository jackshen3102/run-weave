import type { AgentTeamAcceptanceCase, AgentTeamRun, AgentTeamWorker } from "@runweave/shared/agent-team";

const ROLE_LABEL: Record<string, string> = {
  code: "code_agent（写代码）",
  code_review: "code_reviewer（审查）",
  behavior_verify: "behavior_verifier（按验收用例跑 Playwright）",
};
const EVIDENCE_SCHEMA =
  'acceptanceResults[] 必须包含每条 case 独立的 summary 结论；evidence[] 使用 { type, label, summary, ref, detail? }。type 可用 "text"、"dom"、"screenshot"、"command"、"event"、"json"、"log"、"code"；label 是短标题，evidence summary 是单条证据说明，ref 保留原始证据路径、文本或标识。';
const FINDING_SCHEMA =
  '审查类 outbox 如有发现，必须用 remainingFindings / resolvedFindings 表达：仍存在的问题写 remainingFindings，已修复的问题写 resolvedFindings；字段为 { severity: "P0"|"P1"|"P2"|"P3", status?: "open"|"resolved"|"informational", title, summary, ref? }。acceptanceResults 为 pass 时，summary 不要留下未修复 P0/P1 的暗示。';

export function buildMainTestCaseGenerationPrompt(params: {
  run: AgentTeamRun;
  planFilePath?: string | null;
}): string {
  const { run, planFilePath } = params;
  const sourceText = planFilePath
    ? `计划文件：${planFilePath}`
    : `任务描述：${run.task}`;
  return [
    "你是本 Agent Team run 的主 Agent。",
    "",
    `Run: ${run.runId}`,
    `Session: ${run.terminalSessionId}`,
    `ProjectId: ${run.projectId}`,
    "",
    "当前缺少可追溯测试案例文件，禁止直接进入 worker split，也禁止使用默认泛化 acceptance。",
    "请先调用 $toolkit:write-test-cases 生成测试案例文档，然后再提交 worker 拆分提案。",
    "",
    "输入来源：",
    sourceText,
    "",
    "接续要求：",
    "- 测试案例文档写完后，调用 POST /api/agent-team/runs/:runId/propose-split，payload 带 generatedTestCaseFilePath，并使用 code、code_review、behavior_verify 三类 worker。",
    "- 如果无法生成可解析测试案例文件，停止并向用户说明“缺少可追溯测试案例文件”，不要提交 split。",
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
    `任务：${run.task}`,
    "",
    `意图：${worker.intent}`,
  ];
  if (worker.role === "behavior_verify") {
    const sourceDescription = formatAcceptanceSource(run);
    lines.push(
      "",
      `验收来源：${sourceDescription}`,
      "验收用例（逐条跑 Playwright，产出 pass/fail + 截图/DOM 证据）：",
      ...acceptance.map(formatAcceptancePromptLine),
      "",
      outboxPath
        ? `把每条用例的结果写进 ${outboxPath} 的 acceptanceResults：[{ caseId, status: pass|fail|skipped, summary, skipReason?, evidence[] }]。`
        : "把每条用例的结果写进 outbox 的 acceptanceResults：[{ caseId, status: pass|fail|skipped, summary, skipReason?, evidence[] }]。",
      "首轮按测试案例顺序执行；遇到阻断失败可以停止，但必须在 outbox 写清失败 case、失败步骤和证据。",
    );
    if (run.reviewCheckpoint) {
      lines.push(
        `本轮被测 checkpoint：${run.reviewCheckpoint.lastReviewedCommit}`,
        "开始验收前执行 git rev-parse HEAD 并确认等于该 commit。",
        `outbox 顶层 verifiedCheckpointCommit 必须等于 "${run.reviewCheckpoint.lastReviewedCommit}"。`,
      );
    }
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
    lines.push(...formatReviewTargetInstructions(run));
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
  triggerSummary?: string | null;
}): string {
  const { run, worker, cases, outboxPath, triggerSummary } = params;
  const isReviewWorker = worker.role === "code_review";
  const sourceLabel =
    worker.role === "behavior_verify" ? "code_review" : "code pane";
  const caseIds = new Set(cases.map((item) => item.caseId));
  const skippedCases =
    worker.role === "behavior_verify"
      ? run.acceptance.filter(
          (item) => item.status === "pass" && !caseIds.has(item.caseId),
        )
      : [];
  return [
    `[loop round ${run.loop.round}] ${sourceLabel} 已完成修复，请重新${isReviewWorker ? "审查" : "验收"}以下用例：`,
    "",
    ...(worker.role === "behavior_verify"
      ? [
          `验收来源：${formatAcceptanceSource(run)}`,
          triggerSummary ? `本轮修复摘要：${triggerSummary}` : null,
          "",
          "默认重跑范围：失败 case、未执行 case、依赖 case，以及你判断被本轮 diff 影响的已通过 case。",
          "如果扩大为全量重跑，必须在 outbox summary 或 evidence 中写明原因。",
          "",
        ].filter((item): item is string => Boolean(item))
      : []),
    ...cases.map(formatAcceptancePromptLine),
    ...(isReviewWorker ? formatReviewTargetInstructions(run) : []),
    ...(skippedCases.length > 0
      ? [
          "",
          "默认跳过的已通过用例（若本轮 diff 影响它们，请扩大重跑；否则在 outbox 写 skipped + skipReason）：",
          ...skippedCases.map(
            (item) =>
              `- [${item.caseId}] ${item.sourceFilePath ?? "unknown"}：上轮已通过，未被失败点/未执行项/依赖关系命中`,
          ),
        ]
      : []),
    "",
    outboxPath
      ? `把结果写进 ${outboxPath} 的 acceptanceResults：[{ caseId, status: pass|fail|skipped, summary, skipReason?, evidence[] }]。`
      : "把结果写进 outbox 的 acceptanceResults：[{ caseId, status: pass|fail|skipped, summary, skipReason?, evidence[] }]。",
    ...(outboxPath
      ? [
          `outbox 顶层必须包含：sessionId="${run.terminalSessionId}"、panelId="${worker.panelId ?? ""}"、tmuxPaneId="${worker.tmuxPaneId ?? ""}"、runId="${run.runId}"、role="${worker.role}"、status="completed"|"failed"、summary、error、finishedAt。`,
          EVIDENCE_SCHEMA,
          ...(isReviewWorker ? [FINDING_SCHEMA] : []),
        ]
      : []),
    ...(worker.role === "behavior_verify" && run.reviewCheckpoint
      ? [
          `本轮被测 checkpoint：${run.reviewCheckpoint.lastReviewedCommit}`,
          "开始验收前执行 git rev-parse HEAD 并确认等于该 commit。",
          `outbox 顶层 verifiedCheckpointCommit 必须等于 "${run.reviewCheckpoint.lastReviewedCommit}"。`,
        ]
      : []),
  ].join("\n");
}

function formatReviewTargetInstructions(run: AgentTeamRun): string[] {
  const target = run.reviewCheckpoint?.pendingReview;
  if (!target) {
    return [];
  }
  const scopeDescription =
    target.scope === "incremental"
      ? "审查该增量 diff，同时检查失败链路、受影响调用方/消费者和 resolved findings 回归点。"
      : target.scope === "final"
        ? "这是最终收口审查：审查任务起点到最新 checkpoint 的完整 diff。"
        : "这是首次审查：审查任务起点以来的完整 staged diff。";
  return [
    "",
    "Review checkpoint 范围：",
    `- scope=${target.scope}`,
    `- baseCommit=${target.baseCommit}`,
    `- targetTree=${target.targetTree}`,
    `- changedPaths=${target.changedPaths.join(", ")}`,
    `- planSha256=${target.planSha256 ?? "null"}`,
    `- testCaseSha256=${target.testCaseSha256 ?? "null"}`,
    `- requestedAt=${target.requestedAt}`,
    `- ${scopeDescription}`,
    "- outbox 顶层 reviewTarget 必须原样回显本 prompt 的 scope/baseCommit/targetTree/changedPaths/planSha256/testCaseSha256/requestedAt。",
  ];
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

function formatAcceptanceSource(run: AgentTeamRun): string {
  const verification = run.verification;
  if (!verification) {
    return "未记录来源";
  }
  const sourceLabel =
    verification.acceptanceSource === "test_case_file"
      ? "测试案例文件"
      : verification.acceptanceSource === "plan_file_generated"
        ? "计划文件生成"
        : "任务描述生成";
  const filePath =
    verification.testCaseFilePath ??
    verification.generatedTestCaseFilePath ??
    verification.planFilePath ??
    "unknown";
  return `${sourceLabel} ${filePath}`;
}

function formatAcceptancePromptLine(
  item: AgentTeamAcceptanceCase,
  index: number,
): string {
  const source = item.sourceFilePath
    ? ` 来源：${item.sourceFilePath}${item.sourceHeading ? ` / ${item.sourceHeading}` : ""}`
    : "";
  return `${index + 1}. [${item.sourceCaseId ?? item.caseId}] ${item.text}${source}`;
}
