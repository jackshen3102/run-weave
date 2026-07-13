import type {
  AgentTeamFixVerification,
  AgentTeamLoop,
  AgentTeamOutboxFinding,
  AgentTeamRepairCycle,
  AgentTeamRun,
  AgentTeamWorkerOutbox,
  AgentTeamWorkerRole,
} from "@runweave/shared/agent-team";

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
  failureSummary: string;
}

export type CodeFixHandoffValidation =
  | { status: "valid"; repairKeys: string[] }
  | { status: "invalid"; errors: string[] }
  | { status: "blocked"; reason: string };

export function resolveMaxRepairAttempts(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_REPAIR_ATTEMPTS &&
    value <= MAX_REPAIR_ATTEMPTS
    ? value
    : DEFAULT_MAX_REPAIR_ATTEMPTS;
}

export function isValidInvariantKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9][a-z0-9._-]{2,79}$/.test(value.trim())
  );
}

export function blockingReviewFindings(
  outbox: AgentTeamWorkerOutbox,
): AgentTeamOutboxFinding[] {
  return (outbox.remainingFindings ?? []).filter(
    (finding) =>
      (finding.severity === "P0" || finding.severity === "P1") &&
      (finding.status ?? "open") === "open",
  );
}

export function reviewFindingContractErrors(
  outbox: AgentTeamWorkerOutbox,
  acceptanceResults: NonNullable<AgentTeamWorkerOutbox["acceptanceResults"]>,
): string[] {
  if (outbox.role !== "code_review") {
    return [];
  }
  const findings = blockingReviewFindings(outbox);
  const hasFailure =
    acceptanceResults.some((result) => result.status === "fail") ||
    findings.length > 0;
  if (!hasFailure) {
    return [];
  }
  if (findings.length === 0) {
    return [
      "P0/P1 review fail 必须在 remainingFindings 中提供阻断 finding",
    ];
  }
  return findings.flatMap((finding, index) => {
    const errors: string[] = [];
    if (!isValidInvariantKey(finding.invariantKey)) {
      errors.push(
        `remainingFindings[${index}].invariantKey 缺失或格式无效`,
      );
    }
    if (
      finding.verificationMode !== "runtime" &&
      finding.verificationMode !== "structural"
    ) {
      errors.push(
        `remainingFindings[${index}].verificationMode 必须是 runtime 或 structural`,
      );
    }
    return errors;
  });
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
        sourceEvidenceRefs: result.evidence.map((item) => item.ref),
        failureSummary: result.summary ?? invariant,
      };
    });
  }
  if (outbox.role !== "code_review") {
    return [];
  }
  const reviewCaseIds =
    failedResults.length > 0
      ? failedResults.map((result) => result.caseId)
      : run.acceptance
          .filter((item) => /code review|代码审查|code_review/i.test(item.text))
          .map((item) => item.caseId);
  return blockingReviewFindings(outbox).flatMap((finding) => {
    if (
      !isValidInvariantKey(finding.invariantKey) ||
      !finding.verificationMode
    ) {
      return [];
    }
    return [
      {
        repairKey: `code_review:${finding.invariantKey.trim()}`,
        sourceRole: "code_review" as const,
        caseIds: reviewCaseIds,
        invariant: finding.summary,
        verificationMode: finding.verificationMode,
        sourceEvidenceRefs: finding.ref ? [finding.ref] : [],
        failureSummary: `${finding.severity}: ${finding.title}`,
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
        lastFailedRound: round,
        lastFailureSummary: target.failureSummary,
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
      attempts: 0,
      maxAttempts:
        params.loop.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS,
      firstFailedRound: round,
      lastFailedRound: round,
      lastFailureSummary: target.failureSummary,
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
    const reproductionStatus = item.reproduction.status;
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
    if (item.invariant.trim() !== cycle.invariant.trim()) {
      errors.push(`${key} invariant 与 backend repair cycle 不一致`);
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
      }
    } else if (
      item.reproduction.status !== "confirmed" ||
      (item.reproduction.mode !== "review_harness" &&
        item.reproduction.mode !== "static_contract")
    ) {
      errors.push(`${key} structural finding 必须由原 harness 或静态契约确认`);
    }
    if (cycle.verificationMode === "structural") {
      const sourceRefs = cycle.sourceEvidenceRefs ?? [];
      const reproductionRefs = new Set(
        item.reproduction.evidence.map((evidence) => evidence.ref),
      );
      const verificationRefs = new Set(
        item.verification.evidence.map((evidence) => evidence.ref),
      );
      for (const ref of sourceRefs) {
        if (!reproductionRefs.has(ref) || !verificationRefs.has(ref)) {
          errors.push(`${key} 未用 reviewer 原 evidence ref 完成 Before/After：${ref}`);
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
