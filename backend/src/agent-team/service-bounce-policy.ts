import type { AgentTeamRun } from "@runweave/shared/agent-team";

type RepairTargetIdentity = {
  repairKey: string;
  caseIds: string[];
};

export function resolveBounceSelection(
  run: AgentTeamRun,
  forceBounceCaseIds: string[],
  repairTargets: RepairTargetIdentity[],
): { caseIds: string[]; repairKeys: string[] } {
  const forced = new Set(forceBounceCaseIds);
  const stableCaseIds = new Set(
    run.acceptance
      .filter(
        (item) =>
          item.status === "fail" &&
          item.consecutiveFail >= run.loop.stableFailThreshold &&
          !item.bouncedToPanelId,
      )
      .map((item) => item.caseId),
  );
  const forcedFailCaseIds = new Set(
    run.acceptance
      .filter((item) => item.status === "fail" && forced.has(item.caseId))
      .map((item) => item.caseId),
  );
  const caseIds = run.acceptance
    .filter(
      (item) =>
        stableCaseIds.has(item.caseId) || forcedFailCaseIds.has(item.caseId),
    )
    .map((item) => item.caseId);
  const repairKeys = new Set<string>();
  for (const cycle of run.loop.repairCycles ?? []) {
    if (cycle.caseIds.some((caseId) => stableCaseIds.has(caseId))) {
      repairKeys.add(cycle.repairKey);
    }
  }
  for (const target of repairTargets) {
    if (target.caseIds.some((caseId) => forcedFailCaseIds.has(caseId))) {
      repairKeys.add(target.repairKey);
    }
  }
  return { caseIds, repairKeys: Array.from(repairKeys) };
}
