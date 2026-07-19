import { isDeepStrictEqual } from "node:util";
import type { AgentTeamAcceptanceCase } from "@runweave/shared/agent-team";
import { AgentTeamError } from "./errors";

export const AGENT_TEAM_REVIEW_GATE_CASE_ID = "AGT-REVIEW-GATE";

export function isReviewGateAcceptanceCase(
  item: AgentTeamAcceptanceCase,
): boolean {
  return (
    item.caseId === AGENT_TEAM_REVIEW_GATE_CASE_ID ||
    // Persisted runs created before the reserved ID used numbered case_N gates.
    /code review|代码审查|code_review/i.test(item.text)
  );
}

export function assertAcceptanceRefreshPreservesTraceableCases(
  existing: AgentTeamAcceptanceCase[],
  refreshed: AgentTeamAcceptanceCase[],
): void {
  const refreshedCaseIds = new Set(
    refreshed
      .filter((item) => !isReviewGateAcceptanceCase(item))
      .map((item) => item.caseId),
  );
  const missingCaseIds = existing
    .filter(
      (item) =>
        !isReviewGateAcceptanceCase(item) &&
        Boolean(item.sourceCaseId && item.sourceFilePath),
    )
    .map((item) => item.caseId)
    .filter((caseId) => !refreshedCaseIds.has(caseId));
  if (missingCaseIds.length > 0) {
    throw new AgentTeamError(
      409,
      `刷新验收合同不能删除既有可追溯 Case：${missingCaseIds.join(", ")}。请提供包含旧 Case 与新增 Case 的完整测试案例文件`,
    );
  }
}

export function resetPersistedAcceptanceForRefresh(
  acceptance: AgentTeamAcceptanceCase[],
): AgentTeamAcceptanceCase[] {
  return acceptance
    .filter((item) => !isReviewGateAcceptanceCase(item))
    .map((item) => ({
      caseId: item.caseId,
      text: item.text,
      sourceCaseId: item.sourceCaseId ?? null,
      sourceFilePath: item.sourceFilePath ?? null,
      sourceHeading: item.sourceHeading ?? null,
      tags: [...(item.tags ?? [])],
      dependsOn: [...(item.dependsOn ?? [])],
      status: "pending",
      latestObservation: null,
      consecutiveFail: 0,
      resultSummary: null,
      reproduction: null,
      evidence: [],
      bouncedToPanelId: null,
      recheckRequestedAt: null,
      recheckDispatchId: null,
      recheckWorkerPanelId: null,
      recheckWorkerRole: null,
      recheckOutboxMtimeMs: null,
      recheckAttempt: 0,
      lastRunStatus: "pending",
      skip: null,
      skipReason: null,
    }));
}

export function mergeAcceptanceRefresh(
  existing: AgentTeamAcceptanceCase[],
  refreshed: AgentTeamAcceptanceCase[],
  affectedCaseIds: string[],
): AgentTeamAcceptanceCase[] {
  assertAcceptanceRefreshPreservesTraceableCases(existing, refreshed);
  const affected = new Set(affectedCaseIds);
  if (affected.size === 0) {
    throw new AgentTeamError(
      400,
      "refresh_acceptance 必须声明受影响的业务 Case",
    );
  }
  const refreshedProductCases = refreshed.filter(
    (item) => !isReviewGateAcceptanceCase(item),
  );
  const refreshedById = new Map(
    refreshedProductCases.map((item) => [item.caseId, item]),
  );
  const invalidCaseIds = affectedCaseIds.filter(
    (caseId) => !refreshedById.has(caseId),
  );
  if (invalidCaseIds.length > 0) {
    throw new AgentTeamError(
      400,
      `refresh_acceptance 声明了不存在的业务 Case：${invalidCaseIds.join(", ")}`,
    );
  }

  const existingById = new Map(
    existing
      .filter((item) => !isReviewGateAcceptanceCase(item))
      .map((item) => [item.caseId, item]),
  );
  const undeclaredChangedCaseIds = refreshedProductCases
    .filter((item) => {
      const previous = existingById.get(item.caseId);
      return (
        !affected.has(item.caseId) &&
        (!previous || acceptanceCaseContractChanged(previous, item))
      );
    })
    .map((item) => item.caseId);
  if (undeclaredChangedCaseIds.length > 0) {
    throw new AgentTeamError(
      409,
      `refresh_acceptance 修改了未声明受影响的 Case：${undeclaredChangedCaseIds.join(", ")}`,
    );
  }

  const reviewGate =
    existing.find(isReviewGateAcceptanceCase) ??
    refreshed.find(isReviewGateAcceptanceCase);
  return [
    ...(reviewGate ? [reviewGate] : []),
    ...refreshedProductCases.map((item) => {
      const previous = existingById.get(item.caseId);
      if (!previous || affected.has(item.caseId)) {
        return item;
      }
      return {
        ...previous,
        text: item.text,
        sourceCaseId: item.sourceCaseId,
        sourceFilePath: item.sourceFilePath,
        sourceHeading: item.sourceHeading,
        tags: item.tags,
        dependsOn: item.dependsOn,
      };
    }),
  ];
}

function acceptanceCaseContractChanged(
  existing: AgentTeamAcceptanceCase,
  refreshed: AgentTeamAcceptanceCase,
): boolean {
  return !isDeepStrictEqual(
    {
      sourceCaseId: existing.sourceCaseId ?? null,
      text: existing.text,
      tags: existing.tags ?? [],
      dependsOn: existing.dependsOn ?? [],
    },
    {
      sourceCaseId: refreshed.sourceCaseId ?? null,
      text: refreshed.text,
      tags: refreshed.tags ?? [],
      dependsOn: refreshed.dependsOn ?? [],
    },
  );
}
