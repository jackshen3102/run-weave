import type {
  AgentTeamOutboxFinding,
  AgentTeamRun,
  AgentTeamWorkerOutbox,
} from "@runweave/shared/agent-team";

export function isValidInvariantKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9][a-z0-9._-]{2,79}$/.test(value.trim())
  );
}

export function rawBlockingReviewFindings(
  outbox: AgentTeamWorkerOutbox,
): AgentTeamOutboxFinding[] {
  return (outbox.remainingFindings ?? []).filter(
    (finding) =>
      (finding.severity === "P0" || finding.severity === "P1") &&
      (finding.status ?? "open") === "open",
  );
}

export function behaviorFailureContractErrors(
  outbox: AgentTeamWorkerOutbox,
  acceptanceResults: NonNullable<AgentTeamWorkerOutbox["acceptanceResults"]>,
): string[] {
  if (outbox.role !== "behavior_verify") {
    return [];
  }
  return acceptanceResults.flatMap((result) => {
    if (result.status !== "fail") {
      return [];
    }
    const reproduction = result.reproduction;
    if (!reproduction) {
      return [
        `${result.caseId} fail 缺少完整 reproduction；必须提供 real_product + reproduced、scenarioId、validationSessionId、steps、expected、actual 和 evidence`,
      ];
    }
    const errors: string[] = [];
    if (
      reproduction.mode !== "real_product" ||
      reproduction.status !== "reproduced"
    ) {
      errors.push(
        `${result.caseId}.reproduction 必须是 real_product + reproduced`,
      );
    }
    if (!reproduction.scenarioId?.trim()) {
      errors.push(`${result.caseId}.reproduction 缺少 scenarioId`);
    }
    if (!reproduction.validationSessionId?.trim()) {
      errors.push(`${result.caseId}.reproduction 缺少 validationSessionId`);
    }
    if (reproduction.evidence.length === 0 || result.evidence.length === 0) {
      errors.push(`${result.caseId} fail 缺少可追溯复现证据`);
    }
    return errors;
  });
}

export function reviewFindingContractErrors(
  run: AgentTeamRun,
  outbox: AgentTeamWorkerOutbox,
  acceptanceResults: NonNullable<AgentTeamWorkerOutbox["acceptanceResults"]>,
): string[] {
  if (outbox.role !== "code_review") {
    return [];
  }
  const findings = rawBlockingReviewFindings(outbox);
  const hasFailure =
    acceptanceResults.some((result) => result.status === "fail") ||
    findings.length > 0;
  if (!hasFailure) {
    return [];
  }
  if (findings.length === 0) {
    return ["P0/P1 review fail 必须在 remainingFindings 中提供阻断 finding"];
  }
  return findings.flatMap((finding, index) => {
    const errors: string[] = [];
    const repairCycle = finding.invariantKey
      ? (run.loop.repairCycles ?? []).find(
          (cycle) => cycle.repairKey === `code_review:${finding.invariantKey}`,
        )
      : null;
    const requiresExecutableReproduction = Boolean(
      repairCycle && repairCycle.attempts >= 1,
    );
    if (!isValidInvariantKey(finding.invariantKey)) {
      errors.push(`remainingFindings[${index}].invariantKey 缺失或格式无效`);
    }
    if (
      finding.verificationMode !== "runtime" &&
      finding.verificationMode !== "structural"
    ) {
      errors.push(
        `remainingFindings[${index}].verificationMode 必须是 runtime 或 structural`,
      );
    }
    const reproduction = finding.reproduction;
    if (!reproduction) {
      errors.push(
        `remainingFindings[${index}].reproduction 缺失或不完整；无法复现不得提交 open P0/P1`,
      );
      return errors;
    }
    if (
      finding.verificationMode === "runtime" &&
      (reproduction.mode !== "real_product" ||
        reproduction.status !== "reproduced" ||
        !reproduction.scenarioId)
    ) {
      errors.push(
        `remainingFindings[${index}].reproduction 必须是 real_product + reproduced，并提供 scenarioId`,
      );
    }
    if (
      finding.verificationMode === "structural" &&
      (reproduction.mode === "real_product" ||
        (reproduction.status !== "confirmed" &&
          reproduction.status !== "reproduced"))
    ) {
      errors.push(
        `remainingFindings[${index}].reproduction 必须是 review_harness/static_contract + confirmed|reproduced`,
      );
    }
    if (
      requiresExecutableReproduction &&
      (reproduction.mode !== "review_harness" ||
        reproduction.status !== "reproduced" ||
        !reproduction.scenarioId?.trim() ||
        !reproduction.evidence.some((item) => item.type === "command"))
    ) {
      errors.push(
        `remainingFindings[${index}] 是修复后重复出现的 P0/P1，必须使用 review_harness + reproduced，提供 scenarioId 和 command evidence；无法复现就从 remainingFindings 移除`,
      );
    }
    if (reproduction.evidence.length === 0) {
      errors.push(
        `remainingFindings[${index}].reproduction.evidence 至少需要一条可追溯证据`,
      );
    }
    return errors;
  });
}
