import type {
  AgentTeamAcceptanceCase,
  AgentTeamFindingStatus,
  AgentTeamRun,
  AgentTeamWorker,
  AgentTeamWorkerOutbox,
  AgentTeamWorkerRole,
} from "@runweave/shared/agent-team";
import { AgentTeamError } from "./errors";

const RECHECK_TIMEOUT_MS = 60 * 60 * 1000;

export function acceptanceCasesForRole(
  run: AgentTeamRun,
  role: AgentTeamWorkerRole,
): AgentTeamAcceptanceCase[] {
  const acceptance = ensureWorkerGateAcceptance(run.workers, run.acceptance);
  if (role === "code_review") {
    return acceptance.filter(isReviewGateAcceptanceCase);
  }
  if (role === "behavior_verify") {
    return acceptance.filter((item) => !isReviewGateAcceptanceCase(item));
  }
  return acceptance;
}

export function hasRolePassed(
  run: AgentTeamRun,
  role: AgentTeamWorkerRole,
): boolean {
  const cases = acceptanceCasesForRole(run, role);
  return cases.length > 0 && cases.every((item) => item.status === "pass");
}

export function behaviorVerificationCasesForDispatch(
  run: AgentTeamRun,
): AgentTeamAcceptanceCase[] {
  return expandRecheckCasesForFailures(
    run,
    acceptanceCasesForRole(run, "behavior_verify").filter(
      (item) => item.status === "fail" || item.status === "pending",
    ),
  );
}

export function expandRecheckCasesForFailures(
  run: AgentTeamRun,
  seedCases: AgentTeamAcceptanceCase[],
): AgentTeamAcceptanceCase[] {
  const behaviorCases = acceptanceCasesForRole(run, "behavior_verify");
  if (seedCases.every(isReviewGateAcceptanceCase)) {
    return seedCases;
  }
  const selectedIds = new Set(seedCases.map((item) => item.caseId));
  for (const item of behaviorCases) {
    if (item.status === "pending") {
      selectedIds.add(item.caseId);
    }
    if ((item.dependsOn ?? []).some((caseId) => selectedIds.has(caseId))) {
      selectedIds.add(item.caseId);
    }
  }
  return behaviorCases.filter((item) => selectedIds.has(item.caseId));
}

export function findStableFailCaseIdsNeedingBounce(
  run: AgentTeamRun,
): string[] {
  return run.acceptance
    .filter(
      (item) =>
        item.status === "fail" &&
        item.consecutiveFail >= run.loop.stableFailThreshold &&
        !item.bouncedToPanelId,
    )
    .map((item) => item.caseId);
}

export function isUnbouncedFailCase(
  run: AgentTeamRun,
  caseId: string,
): boolean {
  const acceptanceCase = run.acceptance.find((item) => item.caseId === caseId);
  return Boolean(
    acceptanceCase &&
    acceptanceCase.status === "fail" &&
    !acceptanceCase.bouncedToPanelId,
  );
}

export function mergeCaseIds(first: string[], second: string[]): string[] {
  return Array.from(new Set([...first, ...second]));
}

export function ensureWorkerGateAcceptance(
  workers: AgentTeamWorker[],
  acceptance: AgentTeamAcceptanceCase[],
): AgentTeamAcceptanceCase[] {
  if (!workers.some((worker) => worker.role === "code_review")) {
    return acceptance;
  }
  if (acceptance.some(isReviewGateAcceptanceCase)) {
    return acceptance;
  }
  return [
    ...acceptance,
    {
      caseId: `case_${acceptance.length + 1}`,
      text: "Code Review 未发现阻断性问题（P0/P1），或阻断问题已修复",
      status: "pending",
      consecutiveFail: 0,
      resultSummary: null,
      evidence: [],
      bouncedToPanelId: null,
      recheckRequestedAt: null,
      recheckDispatchId: null,
      recheckWorkerPanelId: null,
      recheckWorkerRole: null,
      recheckOutboxMtimeMs: null,
      recheckAttempt: 0,
      lastRunStatus: "pending",
      skipReason: null,
    },
  ];
}

export function assertTraceableBehaviorAcceptance(
  workers: AgentTeamWorker[],
  acceptance: AgentTeamAcceptanceCase[],
): void {
  if (!workers.some((worker) => worker.role === "behavior_verify")) {
    return;
  }
  const behaviorCases = acceptance.filter(
    (item) => !isReviewGateAcceptanceCase(item),
  );
  if (behaviorCases.length === 0) {
    throw new AgentTeamError(
      400,
      "缺少可追溯测试案例文件：behavior_verify 没有可执行验收用例",
    );
  }
  const untraceable = behaviorCases.find(
    (item) => !item.sourceCaseId || !item.sourceFilePath,
  );
  if (untraceable) {
    throw new AgentTeamError(
      400,
      `缺少可追溯测试案例文件：${untraceable.caseId} 没有来源 case 或来源文件`,
    );
  }
}

export function isReviewGateAcceptanceCase(
  item: AgentTeamAcceptanceCase,
): boolean {
  return /code review|代码审查|code_review/i.test(item.text);
}

export function synthesizeBlockingReviewResult(
  run: AgentTeamRun,
  outbox: AgentTeamWorkerOutbox,
): NonNullable<AgentTeamWorkerOutbox["acceptanceResults"]>[number] | null {
  if (!isReviewWorkerOutbox(outbox)) {
    return null;
  }
  const summary = summarizeBlockingReviewFindings(outbox);
  if (!summary) {
    return null;
  }
  const target =
    run.acceptance.find(isReviewGateAcceptanceCase) ?? run.acceptance[0];
  if (!target) {
    return null;
  }
  return {
    caseId: target.caseId,
    status: "fail",
    summary,
    evidence: [
      {
        type: "text",
        label: "审查阻断",
        summary: `${outbox.role} 发现阻断问题：${summary}`,
        ref: `${outbox.role} blocker: ${summary}`,
      },
    ],
  };
}

export function isReviewWorkerOutbox(outbox: AgentTeamWorkerOutbox): boolean {
  return outbox.role === "code_review";
}

export function isGateWorkerOutbox(outbox: AgentTeamWorkerOutbox): boolean {
  return isReviewWorkerOutbox(outbox) || outbox.role === "behavior_verify";
}

export function isImplementationWorkerOutbox(
  outbox: AgentTeamWorkerOutbox,
): boolean {
  return outbox.role === "code";
}

export function resolveRecheckDispatches(
  run: AgentTeamRun,
  cases: AgentTeamAcceptanceCase[],
): Array<{ worker: AgentTeamWorker; cases: AgentTeamAcceptanceCase[] }> {
  const dispatches: Array<{
    worker: AgentTeamWorker;
    cases: AgentTeamAcceptanceCase[];
  }> = [];
  const reviewCases = cases.filter(isReviewGateAcceptanceCase);
  const behaviorCases = cases.filter(
    (item) => !isReviewGateAcceptanceCase(item),
  );
  const reviewWorker =
    run.workers.find(
      (worker) =>
        worker.role === "code_review" && worker.panelId && !worker.frozen,
    ) ?? null;
  const behaviorWorker =
    run.workers.find(
      (worker) =>
        worker.role === "behavior_verify" && worker.panelId && !worker.frozen,
    ) ?? null;

  if (reviewCases.length > 0 && reviewWorker) {
    dispatches.push({ worker: reviewWorker, cases: reviewCases });
  }
  if (behaviorCases.length > 0 && behaviorWorker) {
    dispatches.push({ worker: behaviorWorker, cases: behaviorCases });
  }
  return dispatches;
}

export function hasPendingRecheckRequest(
  item: AgentTeamAcceptanceCase,
): boolean {
  return Boolean(item.recheckRequestedAt && item.status === "pending");
}

export function findRecheckWatchdogCases(
  run: AgentTeamRun,
): AgentTeamAcceptanceCase[] {
  return run.acceptance.filter(
    (item) =>
      isOverdueRecheckCase(item) &&
      recheckCaseBelongsToActiveDispatch(run, item),
  );
}

export function recheckCaseBelongsToActiveDispatch(
  run: AgentTeamRun,
  item: AgentTeamAcceptanceCase,
): boolean {
  const dispatch = run.activeWorkerDispatch;
  if (
    !dispatch ||
    run.activeWorkerRole !== dispatch.role ||
    item.recheckWorkerRole !== dispatch.role ||
    item.recheckWorkerPanelId !== dispatch.panelId ||
    item.recheckRequestedAt !== dispatch.requestedAt ||
    item.recheckOutboxMtimeMs !== dispatch.outboxMtimeMs
  ) {
    return false;
  }
  if (
    item.recheckDispatchId &&
    item.recheckDispatchId !== dispatch.dispatchId
  ) {
    return false;
  }
  if (dispatch.role !== "code_review" || !run.reviewCheckpoint) {
    return true;
  }
  const expected = dispatch.reviewTarget;
  const current = run.reviewCheckpoint.pendingReview;
  return Boolean(
    expected &&
      current &&
      expected.scope === current.scope &&
      expected.baseCommit === current.baseCommit &&
      expected.targetTree === current.targetTree &&
      expected.planSha256 === current.planSha256 &&
      expected.testCaseSha256 === current.testCaseSha256 &&
      expected.requestedAt === current.requestedAt &&
      expected.changedPaths.join("\0") === current.changedPaths.join("\0"),
  );
}

export function isOverdueRecheckCase(item: AgentTeamAcceptanceCase): boolean {
  if (!hasPendingRecheckRequest(item)) {
    return false;
  }
  const requestedAt = Date.parse(item.recheckRequestedAt!);
  return (
    Number.isFinite(requestedAt) &&
    Date.now() - requestedAt >= RECHECK_TIMEOUT_MS
  );
}

export function groupRecheckCasesByWorker(
  cases: AgentTeamAcceptanceCase[],
): AgentTeamAcceptanceCase[][] {
  const groups = new Map<string, AgentTeamAcceptanceCase[]>();
  for (const item of cases) {
    const key =
      item.recheckWorkerPanelId ?? item.recheckWorkerRole ?? item.caseId;
    const existing = groups.get(key);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return Array.from(groups.values());
}

export function summarizeBlockingReviewFindings(
  outbox: AgentTeamWorkerOutbox,
): string | null {
  const remainingFindings = normalizeOutboxFindingList(
    outbox.remainingFindings,
    "open",
  );
  const blockingRemaining = remainingFindings
    .filter(isOpenBlockingFinding)
    .map(formatBlockingFindingSummary);
  if (blockingRemaining.length > 0) {
    return blockingRemaining.join("; ").slice(0, 500);
  }
  if (Array.isArray(outbox.remainingFindings)) {
    return null;
  }
  const legacyFindings = normalizeOutboxFindingList(
    (
      outbox as AgentTeamWorkerOutbox & {
        keyFindings?: unknown;
        findings?: unknown;
      }
    ).keyFindings ??
      (outbox as AgentTeamWorkerOutbox & { findings?: unknown }).findings,
    "open",
  );
  const blockingLegacy = legacyFindings
    .filter(isOpenBlockingFinding)
    .map(formatBlockingFindingSummary);
  if (blockingLegacy.length > 0) {
    return blockingLegacy.join("; ").slice(0, 500);
  }
  const reviewText = outbox as AgentTeamWorkerOutbox & {
    conclusion?: unknown;
  };
  const fallback = [outbox.error, outbox.summary, reviewText.conclusion]
    .filter((item): item is string => Boolean(item))
    .join(" ");
  return /\bP0\b|\bP1\b|blocker|critical|阻断|严重/.test(fallback)
    ? fallback.slice(0, 500)
    : null;
}

export function normalizeOutboxFindingList(
  findings: unknown,
  defaultStatus: AgentTeamFindingStatus,
): NonNullable<AgentTeamWorkerOutbox["remainingFindings"]> {
  if (!Array.isArray(findings)) {
    return [];
  }
  return findings
    .map((finding) => normalizeOutboxFinding(finding, defaultStatus))
    .filter(
      (
        finding,
      ): finding is NonNullable<
        AgentTeamWorkerOutbox["remainingFindings"]
      >[number] => Boolean(finding),
    );
}

export function normalizeOutboxFinding(
  finding: unknown,
  defaultStatus: AgentTeamFindingStatus,
): NonNullable<AgentTeamWorkerOutbox["remainingFindings"]>[number] | null {
  if (!finding || typeof finding !== "object") {
    return null;
  }
  const record = finding as Record<string, unknown>;
  const severity =
    typeof record.severity === "string" ? record.severity.trim() : "";
  if (!/^(P0|P1|P2|P3)$/i.test(severity)) {
    return null;
  }
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const summary =
    typeof record.summary === "string" ? record.summary.trim() : "";
  const impact = typeof record.impact === "string" ? record.impact.trim() : "";
  const resolvedSummary = summary || impact || title;
  if (!resolvedSummary) {
    return null;
  }
  const rawStatus =
    typeof record.status === "string" && record.status.trim()
      ? record.status.trim()
      : defaultStatus;
  const status =
    rawStatus === "resolved" || rawStatus === "informational"
      ? rawStatus
      : "open";
  return {
    severity: severity.toUpperCase() as "P0" | "P1" | "P2" | "P3",
    status,
    title: title || resolvedSummary.slice(0, 120),
    summary: resolvedSummary,
    ...(typeof record.ref === "string" && record.ref.trim()
      ? { ref: record.ref.trim() }
      : {}),
    ...(typeof record.invariantKey === "string" && record.invariantKey.trim()
      ? { invariantKey: record.invariantKey.trim() }
      : {}),
    ...(record.verificationMode === "runtime" ||
    record.verificationMode === "structural"
      ? { verificationMode: record.verificationMode }
      : {}),
  };
}

export function isOpenBlockingFinding(
  finding: NonNullable<AgentTeamWorkerOutbox["remainingFindings"]>[number],
): boolean {
  return (
    (finding.severity === "P0" || finding.severity === "P1") &&
    (finding.status ?? "open") === "open"
  );
}

export function formatBlockingFindingSummary(
  finding: NonNullable<AgentTeamWorkerOutbox["remainingFindings"]>[number],
): string {
  return [finding.severity, finding.title || finding.summary]
    .filter(Boolean)
    .join(": ");
}
