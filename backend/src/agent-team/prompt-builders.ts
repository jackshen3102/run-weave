import type {
  AgentTeamAcceptanceCase,
  AgentTeamRepairCycle,
  AgentTeamRun,
  AgentTeamWorker,
} from "@runweave/shared/agent-team";
import { formatBehaviorValidationAuthorityInstructions } from "./prompt-builders-test-cases";

const ROLE_LABEL: Record<string, string> = {
  code: "code_agent（写代码）",
  code_review: "code_reviewer（审查）",
  behavior_verify: "behavior_verifier（按验收用例跑 Playwright）",
};
const EVIDENCE_SCHEMA =
  'acceptanceResults[] 必须包含每条 case 独立的 summary 结论；evidence[] 使用 { type, label, summary, ref, detail? }。type 可用 "text"、"dom"、"screenshot"、"command"、"event"、"json"、"log"、"code"；label 是短标题，evidence summary 是单条证据说明，ref 保留原始证据路径、文本或标识。';
const BEHAVIOR_FAILURE_REPRODUCTION_SCHEMA =
  'behavior_verify 的每个 fail 还必须包含 reproduction: { mode: "real_product", status: "reproduced", scenarioId, validationSessionId, steps: string[], expected, actual, evidence[] }；无法从真实产品入口完整复现时必须写 skipped + 结构化 skip，不得把推断写成 fail。';
const ACCEPTANCE_SKIP_SCHEMA =
  'behavior_verify 的每个 skipped 必须包含 skip: { code: "blocked_by_case"|"fail_fast"|"environment"|"not_applicable", blockerCaseIds?: string[], blockerFingerprint?: string, blockerScope?: "case"|"run", retryable: boolean, detail: string }。environment 必须填写稳定的小写 blockerFingerprint（同一根因必须复用，仅允许字母数字及 ._:/-，最长 160 字符）和 blockerScope；只有可解除且影响多个 Case 的公共环境阻塞使用 retryable=true + blockerScope="run"，单 Case 阻塞使用 blockerScope="case"。blocked_by_case/fail_fast 必须填写 blockerCaseIds 且 retryable=true；not_applicable 的 retryable 必须为 false。skipReason 仅兼容旧 outbox，不代替 skip。';
const FINDING_SCHEMA =
  '审查类 outbox 如有发现，必须用 remainingFindings / resolvedFindings 表达：仍存在的问题写 remainingFindings，已修复的问题写 resolvedFindings。每个 open P0/P1 必须提供稳定的小写 invariantKey、verificationMode: "runtime"|"structural"，以及 reproduction: { mode: "real_product"|"review_harness"|"static_contract", status: "reproduced"|"confirmed", scenarioId?, validationSessionId?, steps: string[], expected, actual, evidence[] }。runtime finding 只能使用 real_product + reproduced + scenarioId，并写清实际可观察错误；只观察到内部中间状态、静态推断、未复现或环境阻塞时不得提交 open P0/P1。structural finding 必须由 review_harness/static_contract 确认。Final review 的 blocking finding 还必须提供 caseImpacts: [{ caseId, summary, evidence[] }]，caseId 使用 prompt 列出的 backend 产品 Case id，不能使用 generic Code Review gate；每条映射都要说明该复现场景如何违反产品 Case。若问题真实但不属于支持/需求范围，设置 disposition="out_of_scope" 申请人工裁决；reviewer 不得设置 waived。未设置 disposition 默认 blocking。同一 invariant 复用同一 key。acceptanceResults 为 pass 时，summary 不要留下未修复 P0/P1 的暗示。';
const CODE_FIX_VERIFICATION_SCHEMA =
  '- code outbox 必须逐项写 fixVerifications: [{ repairKey, invariant, reproduction: { mode: "real_product"|"review_harness"|"static_contract", status: "reproduced"|"confirmed"|"not_reproduced"|"boundary"|"blocked", scenarioId?, validationSessionId?, evidence[] }, skillInvocation: { name: "$toolkit:reproduce-before-fix", evidence[] }, verification: { status: "pass"|"fail"|"blocked", sameScenario, evidence[] }, impactedChecks: [{ label, dimension: "positive"|"negative"|"temporal"|"concurrent"|"regression", status: "pass"|"fail"|"skipped", summary, evidence[] }], strategyAssessment? }]。';

export { buildMainTestCaseGenerationPrompt } from "./prompt-builders-test-cases";

export function buildWorkerStartupPrompt(params: {
  run: AgentTeamRun;
  worker: AgentTeamWorker;
  acceptance: AgentTeamAcceptanceCase[];
  outboxPath?: string | null;
  evolutionContext?: string | null;
}): string {
  const { run, worker, acceptance, outboxPath, evolutionContext } = params;
  const lines = [
    `你是本 run 的 worker：${ROLE_LABEL[worker.role] ?? worker.role}。`,
    "",
    `Run: ${run.runId}`,
    `Role: ${worker.role}`,
    `Session: ${run.terminalSessionId}`,
    `PanelId: ${worker.panelId ?? ""}`,
    `TmuxPaneId: ${worker.tmuxPaneId ?? ""}`,
    ...formatWorkerDispatchInstructions(run),
    "",
    `任务：${run.task}`,
    "",
    worker.role === "code" && run.reviewCheckpoint
      ? `意图（仅定义功能范围，不授予 Git/checkpoint 操作权限）：${worker.intent}`
      : `意图：${worker.intent}`,
  ];
  if (worker.role === "code" && run.reviewCheckpoint) {
    lines.push(...formatCodeWorkerCheckpointInstructions());
  }
  if (worker.role === "behavior_verify") {
    const sourceDescription = formatAcceptanceSource(run);
    lines.push(
      "",
      `验收来源：${sourceDescription}`,
      ...formatBehaviorValidationAuthorityInstructions(run),
      "验收用例（逐条跑 Playwright，产出 pass/fail + 截图/DOM 证据）：",
      ...acceptance.map(formatAcceptancePromptLine),
      "",
      outboxPath
        ? `把每条用例的结果写进 ${outboxPath} 的 acceptanceResults：[{ caseId, status: pass|fail|skipped, summary, skip?, evidence[] }]。`
        : "把每条用例的结果写进 outbox 的 acceptanceResults：[{ caseId, status: pass|fail|skipped, summary, skip?, evidence[] }]。",
      "首轮按测试案例顺序执行；每个分配 Case 都必须有结果。遇到阻断失败可以停止：失败 Case 写 fail，后续未执行 Case 写 fail_fast 并用 blockerCaseIds 指向失败 Case。",
      ...formatBehaviorFixtureOwnershipInstructions(run),
    );
    const checkpointCommit = behaviorCheckpointCommit(run);
    if (checkpointCommit) {
      lines.push(
        `本轮被测 checkpoint：${checkpointCommit}`,
        "开始验收前执行 git rev-parse HEAD 并确认等于该 commit。",
        `outbox 顶层 verifiedCheckpointCommit 必须等于 "${checkpointCommit}"。`,
      );
    }
  } else if (worker.role === "code_review") {
    lines.push(
      "",
      "审查用例（发现 P0/P1/blocker/critical 时必须写 fail；无阻断问题写 pass）：",
      ...acceptance.map(
        (item, index) => `${index + 1}. [${item.caseId}] ${item.text}`,
      ),
      "",
      outboxPath
        ? `把审查门禁结果写进 ${outboxPath} 的 acceptanceResults。优先使用 Code Review/代码审查相关 caseId；如果没有，使用最相关的 caseId。`
        : "把审查门禁结果写进 outbox 的 acceptanceResults。优先使用 Code Review/代码审查相关 caseId；如果没有，使用最相关的 caseId。",
    );
    lines.push(...formatReviewTargetInstructions(run));
  }
  if (evolutionContext) {
    lines.push(
      "",
      evolutionContext,
      "",
      '- 若使用了 Evolution Context，outbox 顶层必须填写 evolutionFeedback: { disposition: "adopted"|"ignored"|"conflicted", assetRevisionIds: string[], summary: string }；只填写实际暴露的 revision，反馈仅作观察，不单独决定效果。',
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
          ...(worker.role === "behavior_verify"
            ? [
                `- ${BEHAVIOR_FAILURE_REPRODUCTION_SCHEMA}`,
                `- ${ACCEPTANCE_SKIP_SCHEMA}`,
              ]
            : []),
          ...(worker.role === "code_review" ? [`- ${FINDING_SCHEMA}`] : []),
        ]
      : []),
    "- 最终回复以结构化 summary 收尾（状态 / 结论 / 关键发现 / 产物 / 建议下一步）。",
  );
  return lines.join("\n");
}

/** A complete replacement task issued after a framework repair and restart. */
export function buildFrameworkRepairContinuePrompt(params: {
  run: AgentTeamRun;
  worker: AgentTeamWorker;
  cases: AgentTeamAcceptanceCase[];
  outboxPath: string;
}): string {
  const { run, worker, cases, outboxPath } = params;
  const repair = run.frameworkRepair;
  const dispatchId = run.activeWorkerDispatch?.dispatchId;
  if (!repair || repair.result !== "blocked" || !dispatchId) {
    throw new Error(
      "Framework repair continue prompt requires a fresh dispatch",
    );
  }
  const codeRepairContract =
    worker.role === "code"
      ? formatCodeRepairContract(repairCyclesForActiveDispatch(run))
      : [];
  return [
    "这是 Runweave 框架修复并完成 Backend 重启后的继续执行。",
    "本消息是一条完整的新任务，不是旧 prompt 的剩余片段。",
    "",
    `Run: ${run.runId}`,
    `Role: ${worker.role}`,
    `Session: ${run.terminalSessionId}`,
    `PanelId: ${worker.panelId ?? ""}`,
    `TmuxPaneId: ${worker.tmuxPaneId ?? ""}`,
    `DispatchId: ${dispatchId}`,
    `- 旧 dispatch ${repair.target.invalidatedDispatch.dispatchId ?? "unknown"} 已失效，不得复用其结果。`,
    `- outbox 顶层 dispatchId 必须等于 "${dispatchId}"。`,
    "",
    `原任务：${run.task}`,
    `本次只处理这些 Case：${cases.map((item) => item.caseId).join(", ")}`,
    ...(worker.role === "behavior_verify"
      ? formatBehaviorValidationAuthorityInstructions(run)
      : []),
    ...cases.map(formatAcceptancePromptLine),
    ...(worker.role === "code" && run.reviewCheckpoint
      ? formatCodeWorkerCheckpointInstructions()
      : []),
    ...(worker.role === "code_review"
      ? formatReviewTargetInstructions(run)
      : []),
    ...(worker.role === "behavior_verify" && behaviorCheckpointCommit(run)
      ? [
          `本轮被测 checkpoint：${behaviorCheckpointCommit(run)}`,
          "开始验收前执行 git rev-parse HEAD 并确认等于该 commit。",
          `outbox 顶层 verifiedCheckpointCommit 必须等于 "${behaviorCheckpointCommit(run)}"。`,
        ]
      : []),
    ...(codeRepairContract.length > 0 ? ["", ...codeRepairContract] : []),
    "",
    `把结构化结果写入 ${outboxPath}。不要写 session 级 .runweave/outbox/${run.terminalSessionId}.json。`,
    `outbox 顶层必须包含：sessionId="${run.terminalSessionId}"、panelId="${worker.panelId ?? ""}"、tmuxPaneId="${worker.tmuxPaneId ?? ""}"、runId="${run.runId}"、role="${worker.role}"、status="completed"|"failed"、summary、error、finishedAt。`,
    EVIDENCE_SCHEMA,
    ...(worker.role === "behavior_verify"
      ? [BEHAVIOR_FAILURE_REPRODUCTION_SCHEMA, ACCEPTANCE_SKIP_SCHEMA]
      : []),
    ...(worker.role === "code_review" ? [FINDING_SCHEMA] : []),
    "",
    "只处理上述恢复目标，不接管主控调度。完成后以结构化 summary 收尾。",
  ].join("\n");
}

/** Bounce a failed gate case back to a code pane. */
export function buildBounceBackPrompt(params: {
  run: AgentTeamRun;
  failedCases: AgentTeamAcceptanceCase[];
  repairCycles: AgentTeamRepairCycle[];
}): string {
  const { run, failedCases, repairCycles } = params;
  const isReviewGateBounce =
    failedCases.length > 0 && failedCases.every(isReviewGateAcceptanceCase);
  return [
    isReviewGateBounce
      ? `[loop round ${run.loop.round}] 串行门禁报以下用例失败，请修复：`
      : `[loop round ${run.loop.round}] behavior_verify 连续多轮报以下用例失败，请修复：`,
    ...formatWorkerDispatchInstructions(run),
    "",
    ...failedCases.map((item) => {
      const evidence = item.evidence
        .map((ev) => `${ev.label}: ${ev.summary}（ref=${ev.ref}）`)
        .join("; ");
      return `- [${item.caseId}] ${item.text}${evidence ? `\n  证据：${evidence}` : ""}`;
    }),
    "",
    ...formatCodeRepairContract(repairCycles),
    "",
    ...(run.reviewCheckpoint ? formatCodeWorkerCheckpointInstructions() : []),
    ...(run.reviewCheckpoint ? [""] : []),
    isReviewGateBounce
      ? "完成上述自证后无需自行触发独立审查；backend 校验交接后会按 code_review → behavior_verify 顺序重新触发。"
      : "完成上述自证后无需自行触发独立验收；backend 校验交接后会先重新触发 code_review。",
  ].join("\n");
}

function formatCodeRepairContract(
  repairCycles: AgentTeamRepairCycle[],
): string[] {
  if (repairCycles.length === 0) {
    return [];
  }
  const runtimeRepairs = repairCycles.filter(
    (cycle) => cycle.verificationMode === "runtime",
  );
  const structuralRepairs = repairCycles.filter(
    (cycle) => cycle.verificationMode === "structural",
  );
  const requiresStrategyAssessment = repairCycles.some(
    (cycle) => cycle.attempts >= 1,
  );
  const requiresExecutableReviewReproduction = structuralRepairs.some(
    (cycle) => cycle.attempts >= 1,
  );
  return [
    "backend 固定的修复目标（repairKey 不可改名或覆盖）：",
    ...repairCycles.map(
      (cycle) =>
        `- ${cycle.repairKey}｜第 ${cycle.attempts + 1}/${cycle.maxAttempts} 次修复｜invariant: ${cycle.invariant}${cycle.sourceEvidenceRefs?.length ? `｜sourceEvidenceRefs: ${cycle.sourceEvidenceRefs.join(", ")}` : ""}`,
    ),
    ...repairCycles.flatMap(formatRepairSourceReproduction),
    "",
    "修复前强制门槛：",
    "- Codex worker 必须在修改源码前显式调用 $toolkit:reproduce-before-fix，并按 verifier 交接的同一场景完成 Before 复现。",
    '- outbox 的 skillInvocation 必须写 name="$toolkit:reproduce-before-fix" 并附调用证据；缺少证据属于不可事后补写的阻断错误。',
    "",
    ...(runtimeRepairs.length > 0
      ? [
          "Runtime/behavior 复现门槛：",
          "- 必须从真实产品入口稳定复现，记录 scenarioId、validationSessionId 和 Before evidence；mock、fixture、私有函数或静态阅读不能单独算复现。",
          "- 修复后使用同一 scenarioId 和 validationSessionId 原样重跑，记录 After pass evidence。未复现、边界或环境阻塞时停止修改并如实交接。",
          "- verifier 已按资源账本清理旧 Session 时，当前 runtime code repair dispatch 可通过 pnpm dev:session 受控重建同一 validationSessionId；owner scope 必须绑定当前 repair dispatch、repairKey 和 Case，禁止复用旧 endpoint 或更换 Session ID。",
          "",
        ]
      : []),
    ...(structuralRepairs.length > 0
      ? [
          "Structural review 复现门槛：",
          ...(requiresExecutableReviewReproduction
            ? [
                "- 这是修复后重复出现的 P0/P1：必须先原样执行 reviewer 提供的 scenarioId、步骤和 harness；static_contract 不再足够。",
                "- 按相同场景无法复现时不要继续猜测性修改；提交 not_reproduced + 执行证据，backend 会回派 reviewer 现场举证。",
              ]
            : [
                "- 优先原样复跑 reviewer evidence 中的命令或 harness；没有可执行 harness 时提供可复核的静态契约 Before/After。",
              ]),
          "- 不要把纯 Git/类型/结构契约伪装成真实 runtime 场景。",
          "",
        ]
      : []),
    "修复交接：",
    "- 先写出每个 repairKey 被违反的 invariant，再执行与其有关的最小 impactedChecks；从正/负/时序/并发/回归中选择真实相关项，任一必跑项失败立即停止。",
    ...(requiresStrategyAssessment
      ? [
          "- 这是同一 repairKey 的第 2 次或以后修复：strategyAssessment 必填。先解释上一轮机制为何失败，再判断是否需要调整状态所有权、事件边界或数据模型；禁止无机制解释地继续叠加启发式。",
        ]
      : []),
    CODE_FIX_VERIFICATION_SCHEMA,
    "- fixVerifications 只证明可以交给独立 gate 复验；不要用 acceptanceResults 给自己的修复判 pass。",
  ];
}

function repairCyclesForActiveDispatch(
  run: AgentTeamRun,
): AgentTeamRepairCycle[] {
  const repairKeys = new Set(run.activeWorkerDispatch?.repairKeys ?? []);
  return run.loop.repairCycles.filter((cycle) =>
    repairKeys.has(cycle.repairKey),
  );
}

function formatRepairSourceReproduction(cycle: AgentTeamRepairCycle): string[] {
  const reproduction = cycle.sourceReproduction ?? cycle.finding?.reproduction;
  if (!reproduction) {
    return [
      `- ${cycle.repairKey} 缺少 verifier reproduction；禁止修改源码，先回派 verifier 补齐复现场景。`,
    ];
  }
  return [
    `- ${cycle.repairKey} verifier 场景：mode=${reproduction.mode} status=${reproduction.status} scenarioId=${reproduction.scenarioId ?? "null"} validationSessionId=${reproduction.validationSessionId ?? "null"}`,
    ...reproduction.steps.map((step, index) => `  ${index + 1}. ${step}`),
    `  expected: ${reproduction.expected}`,
    `  actual: ${reproduction.actual}`,
  ];
}

export function buildCodeFixHandoffCorrectionPrompt(params: {
  run: AgentTeamRun;
  errors: string[];
}): string {
  return [
    `[loop round ${params.run.loop.round}] code 修复交接协议不完整，禁止继续修改源码。`,
    ...formatWorkerDispatchInstructions(params.run),
    "",
    "只补正当前 pane-scoped outbox 的 fixVerifications：",
    ...params.errors.map((error) => `- ${error}`),
    "",
    "不得改动源码、Git HEAD 或 index；不得更换 backend 下发的 repairKey。补交仍无效将自动升级人工。",
  ].join("\n");
}

export function buildReviewFindingCorrectionPrompt(params: {
  run: AgentTeamRun;
  errors: string[];
}): string {
  return [
    `[loop round ${params.run.loop.round}] code_review finding 协议不完整，禁止重新审查或修改代码。`,
    ...formatWorkerDispatchInstructions(params.run),
    "",
    "只补正当前 pane-scoped outbox 的 remainingFindings：",
    ...params.errors.map((error) => `- ${error}`),
    "",
    "每个 open P0/P1 必须补稳定 invariantKey、verificationMode 和已执行的 reproduction。Final review 的 blocking finding 还必须映射 prompt 列出的可追溯产品 Case；真实但范围存疑的问题使用 out_of_scope 申请人工裁决，reviewer 不得自行 waived。runtime finding 必须真实复现可观察错误；无法复现就从 remainingFindings 移除，不得把推断补写成复现。补交仍无效将自动升级人工。",
  ].join("\n");
}

export function buildBehaviorFailureCorrectionPrompt(params: {
  run: AgentTeamRun;
  errors: string[];
}): string {
  return [
    `[loop round ${params.run.loop.round}] behavior_verify 失败复现协议不完整，禁止回派 code。`,
    ...formatWorkerDispatchInstructions(params.run),
    "",
    ...params.errors.map((error) => `- ${error}`),
    "",
    "只允许补正当前 pane-scoped outbox：如果本轮已经完整执行真实产品场景，补齐原步骤与证据；否则原样重跑失败 case。无法复现时改写为 skipped + 结构化 skip。禁止修改源码或伪造 reproduction。",
    ACCEPTANCE_SKIP_SCHEMA,
  ].join("\n");
}

export function buildAcceptanceSkipCorrectionPrompt(params: {
  run: AgentTeamRun;
  errors: string[];
}): string {
  return [
    `[loop round ${params.run.loop.round}] behavior_verify skip 协议不完整，禁止继续调度。`,
    ...formatWorkerDispatchInstructions(params.run),
    "",
    ...params.errors.map((error) => `- ${error}`),
    "",
    "只补正当前 pane-scoped outbox 的 skipped 结果，不要修改源码或重跑已经完成的 Case。",
    ACCEPTANCE_SKIP_SCHEMA,
  ].join("\n");
}

function formatCodeWorkerCheckpointInstructions(): string[] {
  return [
    "",
    "Review checkpoint Git 边界：",
    "- 本段由 backend 生成，优先于任务或意图中的任何 Git/checkpoint 表述。",
    "- 不要执行任何会改变 Git HEAD 或 index 的命令，包括 git add、commit、amend、reset、stash、rebase、cherry-pick。",
    "- 只把实现保留在未提交工作树；code_review 通过后由 backend 独占创建 checkpoint commit。",
    "- code outbox 不要填写 verifiedCheckpointCommit；该字段只属于 behavior_verify 对已创建 checkpoint 的验证结果。",
  ];
}

function isReviewGateAcceptanceCase(item: AgentTeamAcceptanceCase): boolean {
  return /code review|代码审查|code_review/i.test(item.text);
}

/** Ask a review/verify worker to rerun cases after an upstream handoff. */
export function buildWorkerRecheckPrompt(params: {
  run: AgentTeamRun;
  worker: AgentTeamWorker;
  cases: AgentTeamAcceptanceCase[];
  outboxPath?: string | null;
  triggerSummary?: string | null;
  reviewChallenge?: { repairKeys: string[]; reason: string } | null;
}): string {
  const { run, worker, cases, outboxPath, triggerSummary, reviewChallenge } =
    params;
  const isReviewWorker = worker.role === "code_review";
  const heading = isReviewWorker
    ? `[loop round ${run.loop.round}] Code Agent 已提交本轮代码结果，请独立审查以下用例：`
    : `[loop round ${run.loop.round}] ${run.reviewCheckpoint ? "当前 checkpoint" : "当前代码范围"}已通过指定范围的 code review；以下行为 case 尚未验证或需要复验：`;
  const caseIds = new Set(cases.map((item) => item.caseId));
  const skippedCases =
    worker.role === "behavior_verify"
      ? run.acceptance.filter(
          (item) => item.status === "pass" && !caseIds.has(item.caseId),
        )
      : [];
  return [
    heading,
    ...formatWorkerDispatchInstructions(run),
    ...(worker.role === "behavior_verify"
      ? [
          "review pass 不代表 behavior pass。",
          ...formatBehaviorFixtureOwnershipInstructions(run),
        ]
      : []),
    "",
    ...(worker.role === "behavior_verify"
      ? [
          `验收来源：${formatAcceptanceSource(run)}`,
          ...formatBehaviorValidationAuthorityInstructions(run),
          triggerSummary ? `上游 review 摘要：${triggerSummary}` : null,
          "",
          "默认重跑范围：失败 case、未执行 case、依赖 case，以及你判断被本轮 diff 影响的已通过 case。",
          "如果扩大为全量重跑，必须在 outbox summary 或 evidence 中写明原因。",
          "",
        ].filter((item): item is string => Boolean(item))
      : []),
    ...cases.map(formatAcceptancePromptLine),
    ...(isReviewWorker ? formatReviewTargetInstructions(run) : []),
    ...(isReviewWorker && reviewChallenge
      ? [
          "",
          "重复 P0/P1 复现争议：",
          `- repairKeys: ${reviewChallenge.repairKeys.join(", ")}`,
          `- ${reviewChallenge.reason}`,
          "- 你必须在当前 checkpoint 亲自执行原 scenarioId：复现成功则提交 review_harness + reproduced + command evidence；无法复现则从 remainingFindings 移除。",
          "- 禁止复用上一轮静态证据，禁止用 static_contract 继续维持该 finding。",
        ]
      : []),
    ...(skippedCases.length > 0
      ? [
          "",
          "本轮范围外的已通过用例（若本轮 diff 影响它们，请明确扩大重跑；否则不要写入 acceptanceResults）：",
          ...skippedCases.map(
            (item) =>
              `- [${item.caseId}] ${item.sourceFilePath ?? "unknown"}：上轮已通过，未被失败点/未执行项/依赖关系命中`,
          ),
        ]
      : []),
    "",
    outboxPath
      ? `把结果写进 ${outboxPath} 的 acceptanceResults：[{ caseId, status: pass|fail|skipped, summary, skip?, evidence[] }]。`
      : "把结果写进 outbox 的 acceptanceResults：[{ caseId, status: pass|fail|skipped, summary, skip?, evidence[] }]。",
    "每个本轮分配 Case 都必须有结果；因其他 Case 未通过而未执行时使用 blocked_by_case/fail_fast，并填写 blockerCaseIds。",
    ...(outboxPath
      ? [
          `outbox 顶层必须包含：sessionId="${run.terminalSessionId}"、panelId="${worker.panelId ?? ""}"、tmuxPaneId="${worker.tmuxPaneId ?? ""}"、runId="${run.runId}"、role="${worker.role}"、status="completed"|"failed"、summary、error、finishedAt。`,
          EVIDENCE_SCHEMA,
          ...(worker.role === "behavior_verify"
            ? [BEHAVIOR_FAILURE_REPRODUCTION_SCHEMA, ACCEPTANCE_SKIP_SCHEMA]
            : []),
          ...(isReviewWorker ? [FINDING_SCHEMA] : []),
        ]
      : []),
    ...(worker.role === "behavior_verify" && behaviorCheckpointCommit(run)
      ? (() => {
          const checkpointCommit = behaviorCheckpointCommit(run)!;
          return [
            `本轮被测 checkpoint：${checkpointCommit}`,
            "开始验收前执行 git rev-parse HEAD 并确认等于该 commit。",
            `outbox 顶层 verifiedCheckpointCommit 必须等于 "${checkpointCommit}"。`,
          ];
        })()
      : []),
  ].join("\n");
}

function behaviorCheckpointCommit(run: AgentTeamRun): string | null {
  return (
    run.activeWorkerDispatch?.verifiedCheckpointCommit ??
    run.reviewCheckpoint?.lastReviewedCommit ??
    null
  );
}

function formatWorkerDispatchInstructions(run: AgentTeamRun): string[] {
  const dispatchId = run.activeWorkerDispatch?.dispatchId?.trim();
  if (!dispatchId) {
    return [];
  }
  return [
    `DispatchId: ${dispatchId}`,
    `- outbox 顶层 dispatchId 必须等于 "${dispatchId}"；不得复用或改写其他 dispatch 的结果。`,
  ];
}

function formatBehaviorFixtureOwnershipInstructions(
  run: AgentTeamRun,
): string[] {
  const dispatchId = run.activeWorkerDispatch?.dispatchId?.trim();
  if (!dispatchId) {
    return [];
  }
  return [
    "",
    "真实行为验证 fixture 所有权：",
    `- 本轮 ownerRunId=${run.runId}，ownerDispatchId=${dispatchId}；worker pane 已注入 RUNWEAVE_AGENT_TEAM_RUN_ID，不得 unset、覆盖或绕过。`,
    "- 从本 pane 启动的 pnpm dev:session 会把 owner scope 写进 manifest；候选 Backend 创建的 Agent Team Run 必须是 verification_fixture，并保留 owner case 集合与 fixture namespace。",
    "- 所有 Dev Session、fixture Run、terminal/pane 都属于资源账本；禁止用 done/failed 冒充清理，也禁止物理删除 Run JSON 或 outbox history。",
    "- 必须在 finally 中先执行 pnpm dev:stop --session <id> --json，确认 fixtureCleanup.status=completed（或共享 Backend 的 not_required_shared_backend）且 ownedLiveFixtureRuns=0，再写本轮最终 outbox。",
    "- 最终 outbox 是本轮最后一个持久产物；cleanup 未完成时如实写 skipped/blocked 证据，不得让父 Run 伪完成。",
  ];
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
  const productCases = run.acceptance.filter(
    (item) =>
      item.sourceCaseId &&
      item.sourceFilePath &&
      !isReviewGateAcceptanceCase(item),
  );
  return [
    "",
    "Review checkpoint 范围：",
    `- scope=${target.scope}`,
    `- baseCommit=${target.baseCommit}`,
    `- targetCommit=${target.targetCommit ?? "null"}`,
    `- targetTree=${target.targetTree}`,
    `- changedPaths=${target.changedPaths.join(", ")}`,
    `- planSha256=${target.planSha256 ?? "null"}`,
    `- testCaseSha256=${target.testCaseSha256 ?? "null"}`,
    `- requestedAt=${target.requestedAt}`,
    `- ${scopeDescription}`,
    ...(target.scope === "final"
      ? [
          "- Final blocker 只能映射以下可追溯产品 Case（caseImpacts.caseId 使用 backend id）：",
          ...productCases.map(
            (item) =>
              `  - ${item.caseId}｜${item.sourceCaseId}｜${item.sourceFilePath}｜${item.text}`,
          ),
        ]
      : []),
    "- outbox 顶层 reviewTarget 必须原样回显本 prompt 的 scope/baseCommit/targetCommit/targetTree/changedPaths/planSha256/testCaseSha256/requestedAt。",
  ];
}

export { buildHumanNotePrompt } from "./prompt-builders-human-note";
export {
  buildBlockedBehaviorMainPrompt,
  buildHumanGateMainPrompt,
} from "./prompt-builders-human-gate";

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
  const dependencies =
    item.dependsOn && item.dependsOn.length > 0
      ? ` 依赖：${item.dependsOn.join(", ")}`
      : "";
  return `${index + 1}. [${item.sourceCaseId ?? item.caseId}] ${item.text}${source}${dependencies}`;
}
