import type {
  AgentTeamFindingDecision,
  AgentTeamFixVerification,
  AgentTeamLoop,
  AgentTeamOutboxFinding,
  AgentTeamPendingFindingDecision,
  AgentTeamRepairCycle,
  AgentTeamReviewTarget,
  AgentTeamRun,
  AgentTeamWorkerOutbox,
  AgentTeamWorkerRole,
} from "@runweave/shared/agent-team";
import {
  isValidInvariantKey,
  rawBlockingReviewFindings,
} from "./repair-review-contract";
import {
  findingCaseTraceabilityErrors,
  isTraceableProductCase,
} from "./repair-loop-traceability";
export const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;
export const MIN_REPAIR_ATTEMPTS = 1;
export const MAX_REPAIR_ATTEMPTS = 5;
export interface AgentTeamRepairTarget {
  repairKey: string;
  sourceRole: "code_review" | "behavior_verify";
  caseIds: string[];
  invariant: string;
  verificationMode: "runtime" | "structural";
  sourceEvidenceRefs: string[];
  sourceReproduction?: AgentTeamRepairCycle["sourceReproduction"];
  failureSummary: string;
  finding?: AgentTeamOutboxFinding;
  reviewTarget?: AgentTeamReviewTarget | null;
  reviewOutbox?: AgentTeamWorkerOutbox;
}

export {
  behaviorFailureContractErrors,
  isValidInvariantKey,
  rawBlockingReviewFindings,
  reviewFindingContractErrors,
} from "./repair-review-contract";
export { isTraceableProductCase } from "./repair-loop-traceability";
export type CodeFixHandoffValidation =
  | { status: "valid"; repairKeys: string[] }
  | { status: "invalid"; errors: string[] }
  | {
      status: "reviewer_reproduction_required";
      repairKeys: string[];
      reason: string;
    }
  | { status: "blocked"; reason: string };
export function resolveMaxRepairAttempts(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_REPAIR_ATTEMPTS &&
    value <= MAX_REPAIR_ATTEMPTS
    ? value
    : DEFAULT_MAX_REPAIR_ATTEMPTS;
}
export function blockingReviewFindings(
  run: AgentTeamRun,
  outbox: AgentTeamWorkerOutbox,
): AgentTeamOutboxFinding[] {
  const reviewTarget = resolveReviewTarget(run, outbox);
  return rawBlockingReviewFindings(outbox).filter((finding) => {
    const decision = findFindingDecision(run, finding, reviewTarget);
    return !decision || decision.disposition === "blocking";
  });
}

export function findFindingDecision(
  run: AgentTeamRun,
  finding: AgentTeamOutboxFinding,
  reviewTarget: AgentTeamReviewTarget | null,
): AgentTeamFindingDecision | null {
  const invariantKey = finding.invariantKey?.trim();
  if (!invariantKey) {
    return null;
  }
  const scenarioId = finding.reproduction?.scenarioId?.trim() ?? null;
  return (
    (run.findingDecisions ?? [])
      .slice()
      .reverse()
      .find(
        (decision) =>
          decision.invariantKey === invariantKey &&
          decision.scenarioId === scenarioId &&
          reviewTargetsMatch(decision.reviewTarget, reviewTarget),
      ) ?? null
  );
}

export function resolveFindingCaseIds(
  run: AgentTeamRun,
  finding: AgentTeamOutboxFinding,
  reviewTarget: AgentTeamReviewTarget | null = resolveReviewTarget(run),
): string[] {
  const decision = findFindingDecision(run, finding, reviewTarget);
  const caseIds =
    decision?.disposition === "blocking"
      ? decision.caseIds
      : (finding.caseImpacts ?? []).map((impact) => impact.caseId);
  return Array.from(new Set(caseIds)).filter((caseId) => {
    const acceptanceCase = run.acceptance.find(
      (item) => item.caseId === caseId,
    );
    return Boolean(acceptanceCase && isTraceableProductCase(acceptanceCase));
  });
}

export function resolvePendingFindingDecision(
  run: AgentTeamRun,
  outbox: AgentTeamWorkerOutbox,
): AgentTeamPendingFindingDecision | null {
  if (outbox.role !== "code_review") {
    return null;
  }
  const reviewTarget = resolveReviewTarget(run, outbox);
  for (const finding of rawBlockingReviewFindings(outbox)) {
    if (findFindingDecision(run, finding, reviewTarget)) {
      continue;
    }
    const proposedDisposition = finding.disposition ?? "blocking";
    const traceabilityErrors =
      reviewTarget?.scope === "final"
        ? findingCaseTraceabilityErrors(run, finding)
        : [];
    if (proposedDisposition === "blocking" && traceabilityErrors.length === 0) {
      continue;
    }
    const reason =
      proposedDisposition === "out_of_scope"
        ? "Reviewer 认为该 finding 可复现但不属于产品支持范围，需要人工确认。"
        : proposedDisposition === "waived"
          ? "Reviewer 不能自行豁免 finding，需要人工明确接受风险。"
          : `Final review blocker 缺少可追溯产品 Case：${traceabilityErrors.join("；")}`;
    return {
      id: buildPendingDecisionId(finding, reviewTarget),
      finding,
      outbox,
      reviewTarget,
      reason,
      requestedAt: new Date().toISOString(),
    };
  }
  return null;
}

export function resolveRepairTargets(
  run: AgentTeamRun,
  outbox: AgentTeamWorkerOutbox,
  acceptanceResults: NonNullable<AgentTeamWorkerOutbox["acceptanceResults"]>,
): AgentTeamRepairTarget[] {
  const failedResults = acceptanceResults.filter(
    (result) => result.status === "fail",
  );
  if (outbox.role === "behavior_verify") {
    return failedResults.map((result) => {
      const acceptanceCase = run.acceptance.find(
        (item) => item.caseId === result.caseId,
      );
      const invariant = acceptanceCase?.text ?? result.summary ?? result.caseId;
      return {
        repairKey: `behavior_verify:${result.caseId}`,
        sourceRole: "behavior_verify",
        caseIds: [result.caseId],
        invariant,
        verificationMode: "runtime",
        sourceEvidenceRefs: Array.from(
          new Set([
            ...result.evidence.map((item) => item.ref),
            ...(result.reproduction?.evidence.map((item) => item.ref) ?? []),
          ]),
        ),
        ...(result.reproduction
          ? { sourceReproduction: result.reproduction }
          : {}),
        failureSummary: result.summary ?? invariant,
      };
    });
  }
  if (outbox.role !== "code_review") {
    return [];
  }
  const fallbackReviewCaseIds =
    failedResults.length > 0
      ? failedResults.map((result) => result.caseId)
      : run.acceptance
          .filter((item) => /code review|代码审查|code_review/i.test(item.text))
          .map((item) => item.caseId);
  const reviewTarget = resolveReviewTarget(run, outbox);
  return blockingReviewFindings(run, outbox).flatMap((finding) => {
    if (
      !isValidInvariantKey(finding.invariantKey) ||
      !finding.verificationMode
    ) {
      return [];
    }
    const mappedCaseIds = resolveFindingCaseIds(run, finding, reviewTarget);
    const caseIds =
      mappedCaseIds.length > 0 ? mappedCaseIds : fallbackReviewCaseIds;
    return [
      {
        repairKey: `code_review:${finding.invariantKey.trim()}`,
        sourceRole: "code_review" as const,
        caseIds,
        invariant: finding.summary,
        verificationMode: finding.verificationMode,
        sourceEvidenceRefs: Array.from(
          new Set(finding.reproduction?.evidence.map((item) => item.ref) ?? []),
        ),
        ...(finding.reproduction
          ? { sourceReproduction: finding.reproduction }
          : {}),
        failureSummary: `${finding.severity}: ${finding.title}`,
        finding,
        reviewTarget,
        reviewOutbox: outbox,
      },
    ];
  });
}

export function foldRepairGateResult(params: {
  loop: AgentTeamLoop;
  completedRole: AgentTeamWorkerRole | null | undefined;
  acceptanceResults: NonNullable<AgentTeamWorkerOutbox["acceptanceResults"]>;
  targets: AgentTeamRepairTarget[];
  round: number;
}): { loop: AgentTeamLoop; exhausted: AgentTeamRepairCycle[] } {
  const { completedRole, acceptanceResults, targets, round } = params;
  let repairCycles = (params.loop.repairCycles ?? []).map((cycle) => ({
    ...cycle,
    caseIds: [...cycle.caseIds],
  }));

  if (completedRole === "code_review") {
    const activeKeys = new Set(targets.map((target) => target.repairKey));
    repairCycles = repairCycles.filter(
      (cycle) =>
        cycle.sourceRole !== "code_review" || activeKeys.has(cycle.repairKey),
    );
  } else if (completedRole === "behavior_verify") {
    const passedKeys = new Set(
      acceptanceResults
        .filter((result) => result.status === "pass")
        .map((result) => `behavior_verify:${result.caseId}`),
    );
    repairCycles = repairCycles.filter(
      (cycle) => !passedKeys.has(cycle.repairKey),
    );
  }

  for (const target of targets) {
    const existing = repairCycles.find(
      (cycle) => cycle.repairKey === target.repairKey,
    );
    if (existing) {
      Object.assign(existing, {
        caseIds: target.caseIds,
        invariant: target.invariant,
        verificationMode: target.verificationMode,
        sourceEvidenceRefs: target.sourceEvidenceRefs,
        sourceReproduction: target.sourceReproduction,
        lastFailedRound: round,
        lastFailureSummary: target.failureSummary,
        finding: target.finding,
        reviewTarget: target.reviewTarget,
        reviewOutbox: target.reviewOutbox,
      });
      continue;
    }
    repairCycles.push({
      repairKey: target.repairKey,
      sourceRole: target.sourceRole,
      caseIds: target.caseIds,
      invariant: target.invariant,
      verificationMode: target.verificationMode,
      sourceEvidenceRefs: target.sourceEvidenceRefs,
      sourceReproduction: target.sourceReproduction,
      attempts: 0,
      maxAttempts: params.loop.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS,
      firstFailedRound: round,
      lastFailedRound: round,
      lastFailureSummary: target.failureSummary,
      finding: target.finding,
      reviewTarget: target.reviewTarget,
      reviewOutbox: target.reviewOutbox,
    });
  }

  const targetKeys = new Set(targets.map((target) => target.repairKey));
  const exhausted = repairCycles.filter(
    (cycle) =>
      targetKeys.has(cycle.repairKey) && cycle.attempts >= cycle.maxAttempts,
  );
  return {
    loop: { ...params.loop, repairCycles },
    exhausted,
  };
}

function resolveReviewTarget(
  run: AgentTeamRun,
  outbox?: AgentTeamWorkerOutbox,
): AgentTeamReviewTarget | null {
  return (
    run.activeWorkerDispatch?.reviewTarget ??
    outbox?.reviewTarget ??
    run.reviewCheckpoint?.pendingReview ??
    null
  );
}

function reviewTargetsMatch(
  left: AgentTeamReviewTarget | null,
  right: AgentTeamReviewTarget | null,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.scope === right.scope &&
    left.baseCommit === right.baseCommit &&
    (left.targetCommit ?? null) === (right.targetCommit ?? null) &&
    left.targetTree === right.targetTree &&
    left.planSha256 === right.planSha256 &&
    left.testCaseSha256 === right.testCaseSha256
  );
}

function buildPendingDecisionId(
  finding: AgentTeamOutboxFinding,
  reviewTarget: AgentTeamReviewTarget | null,
): string {
  return [
    finding.invariantKey ?? "unknown",
    finding.reproduction?.scenarioId ?? "no-scenario",
    reviewTarget?.targetTree ?? "no-target",
  ].join(":");
}

export function incrementRepairAttempts(
  loop: AgentTeamLoop,
  repairKeys: string[],
): AgentTeamLoop {
  const keys = new Set(repairKeys);
  return {
    ...loop,
    repairCycles: (loop.repairCycles ?? []).map((cycle) =>
      keys.has(cycle.repairKey)
        ? { ...cycle, attempts: cycle.attempts + 1 }
        : cycle,
    ),
  };
}

export function repairCyclesForCases(
  loop: AgentTeamLoop,
  caseIds: string[],
): AgentTeamRepairCycle[] {
  const selected = new Set(caseIds);
  return (loop.repairCycles ?? []).filter((cycle) =>
    cycle.caseIds.some((caseId) => selected.has(caseId)),
  );
}

export function validateCodeFixHandoff(
  run: AgentTeamRun,
  outbox: AgentTeamWorkerOutbox,
): CodeFixHandoffValidation {
  const expectedKeys = run.activeWorkerDispatch?.repairKeys ?? [];
  if (expectedKeys.length === 0) {
    return { status: "valid", repairKeys: [] };
  }
  const cycles = new Map(
    (run.loop.repairCycles ?? []).map((cycle) => [cycle.repairKey, cycle]),
  );
  const verifications = new Map<string, AgentTeamFixVerification>();
  for (const item of outbox.fixVerifications ?? []) {
    if (verifications.has(item.repairKey)) {
      return {
        status: "invalid",
        errors: [`repairKey ${item.repairKey} 重复`],
      };
    }
    verifications.set(item.repairKey, item);
  }
  const expected = new Set(expectedKeys);
  const actual = new Set(verifications.keys());
  const errors: string[] = [];
  const reviewerReproductionKeys: string[] = [];
  for (const key of expected) {
    if (!actual.has(key)) {
      errors.push(`缺少 fixVerifications: ${key}`);
    }
  }
  for (const key of actual) {
    if (!expected.has(key)) {
      errors.push(`包含非当前 dispatch 的 repairKey: ${key}`);
    }
  }
  if (errors.length > 0) {
    return { status: "invalid", errors };
  }

  for (const key of expectedKeys) {
    const cycle = cycles.get(key);
    const item = verifications.get(key);
    if (!cycle || !item) {
      errors.push(`repair cycle 不存在: ${key}`);
      continue;
    }
    if (item.invariant.trim() !== cycle.invariant.trim()) {
      errors.push(`${key} invariant 与 backend repair cycle 不一致`);
    }
    const reproductionStatus = item.reproduction.status;
    if (
      item.skillInvocation?.name !== "$toolkit:reproduce-before-fix" ||
      item.skillInvocation.evidence.length === 0
    ) {
      return {
        status: "blocked",
        reason: `${key} 缺少修改源码前调用 $toolkit:reproduce-before-fix 的可追溯证据；该门槛不能事后补写`,
      };
    }
    const sourceReproduction =
      cycle.sourceReproduction ?? cycle.finding?.reproduction;
    if (sourceReproduction?.scenarioId?.trim()) {
      if (
        item.reproduction.scenarioId?.trim() !==
        sourceReproduction.scenarioId.trim()
      ) {
        errors.push(
          `${key} 未复用 verifier scenarioId ${sourceReproduction.scenarioId}`,
        );
      }
      if (item.reproduction.mode !== sourceReproduction.mode) {
        errors.push(`${key} 未复用 verifier reproduction mode`);
      }
    }
    if (
      cycle.sourceRole === "code_review" &&
      cycle.attempts >= 1 &&
      reproductionStatus === "not_reproduced"
    ) {
      const reviewerScenarioId =
        cycle.finding?.reproduction?.scenarioId?.trim();
      if (!reviewerScenarioId) {
        errors.push(`${key} reviewer 未提供可执行 scenarioId`);
      } else if (item.reproduction.scenarioId?.trim() !== reviewerScenarioId) {
        errors.push(
          `${key} 未按 reviewer scenarioId ${reviewerScenarioId} 复现`,
        );
      }
      if (item.reproduction.mode !== cycle.finding?.reproduction?.mode) {
        errors.push(`${key} 未使用 reviewer 下发的复现模式`);
      }
      if (item.reproduction.evidence.length === 0) {
        errors.push(`${key} not_reproduced 缺少执行证据`);
      }
      reviewerReproductionKeys.push(key);
      continue;
    }
    if (
      reproductionStatus === "not_reproduced" ||
      reproductionStatus === "boundary" ||
      reproductionStatus === "blocked" ||
      item.verification.status === "fail" ||
      item.verification.status === "blocked" ||
      item.impactedChecks.some((check) => check.status === "fail")
    ) {
      return {
        status: "blocked",
        reason: `${key} 未达到修复交接门槛：reproduction=${reproductionStatus}, verification=${item.verification.status}, impactedCheckFailed=${item.impactedChecks.some((check) => check.status === "fail")}`,
      };
    }
    if (cycle.verificationMode === "runtime") {
      if (
        item.reproduction.mode !== "real_product" ||
        item.reproduction.status !== "reproduced"
      ) {
        errors.push(`${key} runtime finding 必须真实复现`);
      }
      if (!item.reproduction.scenarioId?.trim()) {
        errors.push(`${key} 缺少 scenarioId`);
      }
      if (!item.reproduction.validationSessionId?.trim()) {
        errors.push(`${key} 缺少 validationSessionId`);
      } else if (
        sourceReproduction?.validationSessionId?.trim() &&
        item.reproduction.validationSessionId.trim() !==
          sourceReproduction.validationSessionId.trim()
      ) {
        errors.push(
          `${key} 未复用 verifier validationSessionId ${sourceReproduction.validationSessionId}`,
        );
      }
    } else if (
      (item.reproduction.status !== "confirmed" &&
        item.reproduction.status !== "reproduced") ||
      (item.reproduction.mode !== "review_harness" &&
        item.reproduction.mode !== "static_contract")
    ) {
      errors.push(`${key} structural finding 必须由原 harness 或静态契约确认`);
    }
    if (cycle.verificationMode === "structural") {
      const sourceEvidence =
        sourceReproduction?.evidence.map((evidence) => evidence.ref) ?? [];
      const sourceRefs =
        sourceReproduction?.mode === "review_harness"
          ? Array.from(
              new Set(
                sourceReproduction.evidence
                  .filter((evidence) => evidence.type === "command")
                  .map((evidence) => evidence.ref),
              ),
            )
          : sourceEvidence.length > 0
            ? sourceEvidence
            : (cycle.sourceEvidenceRefs ?? []);
      const reproductionRefs = new Set(
        item.reproduction.evidence.map((evidence) => evidence.ref),
      );
      for (const ref of sourceRefs) {
        if (!reproductionRefs.has(ref)) {
          errors.push(
            `${key} 未引用 verifier 原始 Before evidence ref：${ref}`,
          );
        }
      }
    }
    if (item.reproduction.evidence.length === 0) {
      errors.push(`${key} 缺少 Before evidence`);
    }
    if (
      item.verification.status !== "pass" ||
      !item.verification.sameScenario ||
      item.verification.evidence.length === 0
    ) {
      errors.push(`${key} 缺少同场景 After pass evidence`);
    }
    if (
      item.impactedChecks.length === 0 ||
      !item.impactedChecks.some((check) => check.status === "pass")
    ) {
      errors.push(`${key} impactedChecks 必须至少一项通过`);
    }
    if (
      item.impactedChecks.some(
        (check) => check.status === "pass" && check.evidence.length === 0,
      )
    ) {
      errors.push(`${key} 通过的 impactedChecks 缺少 evidence`);
    }
    if (cycle.attempts >= 1 && !item.strategyAssessment?.trim()) {
      errors.push(`${key} 第 2 次及以后修复缺少 strategyAssessment`);
    }
  }

  if (errors.length === 0 && reviewerReproductionKeys.length > 0) {
    return {
      status: "reviewer_reproduction_required",
      repairKeys: reviewerReproductionKeys,
      reason: `code worker 按 reviewer 场景无法复现：${reviewerReproductionKeys.join(", ")}；reviewer 必须在当前 checkpoint 亲自复现并提供新证据，否则移除 finding`,
    };
  }

  return errors.length > 0
    ? { status: "invalid", errors }
    : { status: "valid", repairKeys: expectedKeys };
}

export function buildRepairEscalationReason(
  cycles: AgentTeamRepairCycle[],
): string {
  return `修复预算耗尽：${cycles
    .map(
      (cycle) =>
        `${cycle.repairKey} 已完成 ${cycle.attempts}/${cycle.maxAttempts} 次合格修复交接后仍失败`,
    )
    .join("；")}`;
}
