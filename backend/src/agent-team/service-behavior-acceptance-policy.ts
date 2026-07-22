import type {
  AgentTeamAcceptanceCase,
  AgentTeamAcceptanceSkip,
  AgentTeamActiveWorkerDispatch,
  AgentTeamEnvironmentRecoveryProbe,
  AgentTeamRun,
  AgentTeamWorkerOutbox,
} from "@runweave/shared/agent-team";
import { AgentTeamError } from "./errors";
import { isReviewGateAcceptanceCase } from "./service-acceptance-refresh-policy";

export function behaviorVerificationCasesForDispatch(
  run: AgentTeamRun,
): AgentTeamAcceptanceCase[] {
  const behaviorCases = behaviorAcceptanceCases(run);
  const caseById = new Map(behaviorCases.map((item) => [item.caseId, item]));
  const readyCases = behaviorCases.filter(
    (item) =>
      (item.status === "fail" || item.status === "pending") &&
      isCaseReadyForAutomaticDispatch(item, caseById),
  );
  const recoveryCases = readyCases.filter((item) => item.environmentRecovery);
  if (recoveryCases.length > 0) {
    const latestRecovery = recoveryCases
      .map((item) => item.environmentRecovery!)
      .sort((left, right) =>
        right.resolvedAt.localeCompare(left.resolvedAt),
      )[0]!;
    const nextCase = recoveryCases.find(
      (item) =>
        item.environmentRecovery?.resolvedByDispatchId ===
        latestRecovery.resolvedByDispatchId,
    );
    return nextCase ? [nextCase] : [];
  }
  return expandRecheckCasesForFailures(run, readyCases);
}

export function environmentRecoveryProbeForDispatch(
  run: AgentTeamRun,
  selectedCases: AgentTeamAcceptanceCase[],
): AgentTeamEnvironmentRecoveryProbe | null {
  if (selectedCases.length === 0) {
    return null;
  }
  const selectedBlockers = selectedCases.filter(isRunScopedEnvironmentBlocker);
  if (selectedBlockers.length !== selectedCases.length) {
    return null;
  }
  const blockerFingerprint = selectedBlockers[0]!.skip!.blockerFingerprint!;
  if (
    selectedBlockers.some(
      (item) => item.skip?.blockerFingerprint !== blockerFingerprint,
    )
  ) {
    return null;
  }
  const affectedCases = behaviorAcceptanceCases(run).filter(
    (item) =>
      isRunScopedEnvironmentBlocker(item) &&
      item.skip?.blockerFingerprint === blockerFingerprint,
  );
  return {
    blockerFingerprint,
    blockerScope: "run",
    probeCases: selectedBlockers.slice(0, 1).map((item) => ({
      caseId: item.caseId,
      observation: { ...item.latestObservation! },
      skip: cloneAcceptanceSkip(item.skip!),
    })),
    affectedCaseIds: affectedCases.map((item) => item.caseId),
  };
}

export function resolveEnvironmentRecoveryIntervention(
  run: AgentTeamRun,
  requestedCaseIds: string[] | undefined,
): {
  case: AgentTeamAcceptanceCase;
  probe: AgentTeamEnvironmentRecoveryProbe;
} | null {
  const blockers = behaviorAcceptanceCases(run).filter(
    isRunScopedEnvironmentBlocker,
  );
  if (blockers.length === 0) {
    return null;
  }

  const requestedIds = new Set(requestedCaseIds ?? []);
  let selectedBlockers: AgentTeamAcceptanceCase[];
  if (requestedIds.size === 0) {
    if (!isBlockedBehaviorRecoveryGate(run)) {
      return null;
    }
    selectedBlockers = blockers;
  } else {
    selectedBlockers = blockers.filter((item) => requestedIds.has(item.caseId));
    if (selectedBlockers.length === 0) {
      return null;
    }
    if (selectedBlockers.length !== requestedIds.size) {
      throw new AgentTeamError(
        400,
        "environment recovery 不能混选普通 Case、case-scoped blocker 或未知 Case",
      );
    }
  }

  const fingerprints = Array.from(
    new Set(selectedBlockers.map((item) => item.skip!.blockerFingerprint!)),
  );
  if (fingerprints.length !== 1) {
    throw new AgentTeamError(
      400,
      `environment recovery 必须明确选择一个 fingerprint：${formatEnvironmentRecoveryOptions(blockers)}`,
    );
  }
  const fingerprint = fingerprints[0]!;
  const affectedCases = blockers.filter(
    (item) => item.skip?.blockerFingerprint === fingerprint,
  );
  const probe = environmentRecoveryProbeForDispatch(run, affectedCases);
  if (!probe) {
    throw new AgentTeamError(409, "environment recovery probe 无法建立");
  }
  return { case: affectedCases[0]!, probe };
}

export function applyEnvironmentRecoveryProbe(params: {
  acceptance: AgentTeamAcceptanceCase[];
  activeWorkerDispatch: AgentTeamActiveWorkerDispatch | null | undefined;
  acceptanceResults: AgentTeamWorkerOutbox["acceptanceResults"];
  recordedAt: string;
}): {
  acceptance: AgentTeamAcceptanceCase[];
  blockerFingerprint: string | null;
  invalidatedCaseIds: string[];
} {
  const probe = params.activeWorkerDispatch?.environmentRecoveryProbe;
  const dispatchId = params.activeWorkerDispatch?.dispatchId;
  if (!probe || !dispatchId) {
    return {
      acceptance: params.acceptance,
      blockerFingerprint: null,
      invalidatedCaseIds: [],
    };
  }
  const resultByCaseId = new Map(
    (params.acceptanceResults ?? []).map((result) => [result.caseId, result]),
  );
  if (
    !probe.probeCases.every((item) => {
      const status = resultByCaseId.get(item.caseId)?.status;
      return status === "pass" || status === "fail";
    })
  ) {
    return {
      acceptance: params.acceptance,
      blockerFingerprint: null,
      invalidatedCaseIds: [],
    };
  }

  const probeByCaseId = new Map(
    probe.probeCases.map((item) => [item.caseId, item]),
  );
  const affectedCaseIds = new Set(probe.affectedCaseIds);
  const invalidatedCaseIds: string[] = [];
  const acceptance = params.acceptance.map((item) => {
    if (!affectedCaseIds.has(item.caseId)) {
      return item;
    }
    const probeCase = probeByCaseId.get(item.caseId);
    const matchingPersistedSkip =
      isRunScopedEnvironmentBlocker(item) &&
      item.skip?.blockerFingerprint === probe.blockerFingerprint;
    if (!probeCase && !matchingPersistedSkip) {
      return item;
    }
    const invalidatedObservation = probeCase
      ? { ...probeCase.observation }
      : item.latestObservation
        ? { ...item.latestObservation }
        : null;
    const invalidatedSkip = probeCase
      ? cloneAcceptanceSkip(probeCase.skip)
      : item.skip
        ? cloneAcceptanceSkip(item.skip)
        : null;
    invalidatedCaseIds.push(item.caseId);
    const environmentRecovery = {
      blockerFingerprint: probe.blockerFingerprint,
      blockerScope: "run" as const,
      resolvedAt: params.recordedAt,
      resolvedByCaseIds: probe.probeCases.map((probeItem) => probeItem.caseId),
      resolvedByDispatchId: dispatchId,
      invalidatedObservation,
      invalidatedSkip,
    };
    if (probeCase) {
      return { ...item, environmentRecovery };
    }
    return {
      ...item,
      latestObservation: null,
      status: "pending" as const,
      lastRunStatus: "pending" as const,
      skip: null,
      skipReason: null,
      consecutiveFail: 0,
      resultSummary: null,
      reproduction: null,
      bouncedToPanelId: null,
      recheckRequestedAt: null,
      recheckDispatchId: null,
      recheckWorkerPanelId: null,
      recheckWorkerRole: null,
      recheckOutboxMtimeMs: null,
      recheckAttempt: 0,
      environmentRecovery,
    };
  });
  return {
    acceptance,
    blockerFingerprint: probe.blockerFingerprint,
    invalidatedCaseIds,
  };
}

export function expandRecheckCasesForFailures(
  run: AgentTeamRun,
  seedCases: AgentTeamAcceptanceCase[],
): AgentTeamAcceptanceCase[] {
  const behaviorCases = behaviorAcceptanceCases(run);
  if (seedCases.every(isReviewGateAcceptanceCase)) {
    return seedCases;
  }
  const selectedIds = new Set(seedCases.map((item) => item.caseId));
  const caseById = new Map(behaviorCases.map((item) => [item.caseId, item]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of behaviorCases) {
      if (
        selectedIds.has(item.caseId) ||
        !isCaseReadyForAutomaticDispatch(item, caseById) ||
        !(item.dependsOn ?? []).some((caseId) => selectedIds.has(caseId))
      ) {
        continue;
      }
      selectedIds.add(item.caseId);
      changed = true;
    }
  }
  return behaviorCases.filter((item) => selectedIds.has(item.caseId));
}

export function behaviorSkipContractErrors(
  run: AgentTeamRun,
  results: NonNullable<AgentTeamWorkerOutbox["acceptanceResults"]>,
): string[] {
  if (run.workerDispatchProtocolVersion !== 1) {
    return [];
  }
  const knownCaseIds = new Set(run.acceptance.map((item) => item.caseId));
  const errors: string[] = [];
  for (const result of results) {
    if (result.status !== "skipped") {
      continue;
    }
    if (!result.skip) {
      errors.push(
        `${result.caseId} skipped 缺少结构化 skip（code/blockerCaseIds/blockerFingerprint/blockerScope/retryable/detail）`,
      );
      continue;
    }
    const blockerCaseIds = result.skip.blockerCaseIds ?? [];
    if (
      (result.skip.code === "blocked_by_case" ||
        result.skip.code === "fail_fast") &&
      blockerCaseIds.length === 0
    ) {
      errors.push(`${result.caseId} ${result.skip.code} 缺少 blockerCaseIds`);
    }
    if (
      (result.skip.code === "blocked_by_case" ||
        result.skip.code === "fail_fast") &&
      !result.skip.retryable
    ) {
      errors.push(
        `${result.caseId} ${result.skip.code} 的 retryable 必须为 true`,
      );
    }
    const invalidBlockerCaseIds = blockerCaseIds.filter(
      (caseId) => caseId === result.caseId || !knownCaseIds.has(caseId),
    );
    if (invalidBlockerCaseIds.length > 0) {
      errors.push(
        `${result.caseId} blockerCaseIds 非法：${invalidBlockerCaseIds.join(", ")}`,
      );
    }
    if (result.skip.code === "not_applicable" && result.skip.retryable) {
      errors.push(`${result.caseId} not_applicable 的 retryable 必须为 false`);
    }
    if (result.skip.code === "environment") {
      if (!result.skip.blockerFingerprint) {
        errors.push(`${result.caseId} environment 缺少合法 blockerFingerprint`);
      }
      if (!result.skip.blockerScope) {
        errors.push(`${result.caseId} environment 缺少 blockerScope`);
      }
    } else if (
      result.skip.blockerFingerprint !== undefined ||
      result.skip.blockerScope !== undefined
    ) {
      errors.push(
        `${result.caseId} 仅 environment skip 可声明 blockerFingerprint/blockerScope`,
      );
    }
  }
  return errors;
}

function behaviorAcceptanceCases(run: AgentTeamRun): AgentTeamAcceptanceCase[] {
  return run.acceptance.filter((item) => !isReviewGateAcceptanceCase(item));
}

function isRunScopedEnvironmentBlocker(item: AgentTeamAcceptanceCase): boolean {
  return (
    item.latestObservation?.outcome === "skipped" &&
    item.skip?.code === "environment" &&
    item.skip.retryable &&
    item.skip.blockerScope === "run" &&
    Boolean(item.skip.blockerFingerprint)
  );
}

function isBlockedBehaviorRecoveryGate(run: AgentTeamRun): boolean {
  return (
    run.status === "need_human" &&
    Boolean(
      run.loop.lastReason?.startsWith("behavior_verify 结构化跳过") ||
      run.loop.lastReason?.startsWith("behavior_verify 环境阻塞"),
    )
  );
}

function formatEnvironmentRecoveryOptions(
  blockers: AgentTeamAcceptanceCase[],
): string {
  const firstCaseByFingerprint = new Map<string, string>();
  for (const item of blockers) {
    const fingerprint = item.skip!.blockerFingerprint!;
    if (!firstCaseByFingerprint.has(fingerprint)) {
      firstCaseByFingerprint.set(fingerprint, item.caseId);
    }
  }
  return Array.from(
    firstCaseByFingerprint,
    ([fingerprint, caseId]) => `${fingerprint}(${caseId})`,
  ).join(", ");
}

function cloneAcceptanceSkip(
  skip: AgentTeamAcceptanceSkip,
): AgentTeamAcceptanceSkip {
  return {
    ...skip,
    ...(skip.blockerCaseIds
      ? { blockerCaseIds: [...skip.blockerCaseIds] }
      : {}),
  };
}

function isCaseReadyForAutomaticDispatch(
  item: AgentTeamAcceptanceCase,
  caseById: Map<string, AgentTeamAcceptanceCase>,
): boolean {
  if (item.lastRunStatus !== "skipped") {
    return true;
  }
  const skip = item.skip;
  if (!skip?.retryable) {
    return false;
  }
  if (skip.code === "environment" || skip.code === "not_applicable") {
    return false;
  }
  const blockerCaseIds = skip.blockerCaseIds ?? [];
  return (
    blockerCaseIds.length > 0 &&
    blockerCaseIds.every((caseId) => caseById.get(caseId)?.status === "pass")
  );
}
