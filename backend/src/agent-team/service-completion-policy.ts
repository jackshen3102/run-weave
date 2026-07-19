import {
  resolveAgentTeamAcceptanceDecision,
  resolveAgentTeamAcceptanceObservedOutcome,
} from "@runweave/shared/agent-team";
import type {
  AgentTeamCompletionException,
  AgentTeamCompletionOutcome,
  AgentTeamRun,
} from "@runweave/shared/agent-team";
import { isReviewGateAcceptanceCase } from "./service-acceptance-refresh-policy";

export type AgentTeamCompletionBlockerCode =
  | "not_executing"
  | "acceptance_missing"
  | "unresolved_acceptance"
  | "review_gate"
  | "pending_finding"
  | "repair_cycle"
  | "framework_repair"
  | "active_dispatch"
  | "final_review";

export interface AgentTeamCompletionBlocker {
  code: AgentTeamCompletionBlockerCode;
  caseIds: string[];
  message: string;
}

export type AgentTeamCompletionEvaluation =
  | { ready: false; blockers: AgentTeamCompletionBlocker[] }
  | {
      ready: true;
      result: "succeeded" | "completed_with_exceptions";
      exceptions: AgentTeamCompletionException[];
    };

export function projectAgentTeamRunForRead(run: AgentTeamRun): AgentTeamRun {
  const acceptance = run.acceptance.map((item) => {
    if (item.latestObservation) {
      return item;
    }
    const outcome = resolveAgentTeamAcceptanceObservedOutcome(item);
    if (outcome === "pending") {
      return item;
    }
    return {
      ...item,
      latestObservation: {
        outcome,
        dispatchId: null,
        recordedAt: run.updatedAt,
      },
    };
  });
  const projected = {
    ...run,
    acceptance,
    acceptanceDecisions: run.acceptanceDecisions ?? [],
  };
  const completionOutcome =
    run.completionOutcome ?? projectLegacyCompletionOutcome(projected);
  if (!completionOutcome) {
    return { ...projected, completionOutcome: null };
  }
  return {
    ...projected,
    completionOutcome,
    completionHistory:
      run.completionHistory && run.completionHistory.length > 0
        ? run.completionHistory
        : [completionOutcome],
  };
}

export function evaluateAgentTeamCompletion(
  run: AgentTeamRun,
): AgentTeamCompletionEvaluation {
  const blockers: AgentTeamCompletionBlocker[] = [];
  const addBlocker = (
    code: AgentTeamCompletionBlockerCode,
    message: string,
    caseIds: string[] = [],
  ) => blockers.push({ code, caseIds, message });
  if (run.phase !== "executing") {
    addBlocker("not_executing", "Run 尚未进入 executing");
  }
  if (run.acceptance.length === 0) {
    addBlocker("acceptance_missing", "Run 没有验收 Case");
  }
  const unresolvedProductCaseIds = run.acceptance
    .filter(
      (item) =>
        !isReviewGateAcceptanceCase(item) &&
        resolveAgentTeamAcceptanceObservedOutcome(item) !== "pass" &&
        !resolveAgentTeamAcceptanceDecision(run, item),
    )
    .map((item) => item.caseId);
  if (unresolvedProductCaseIds.length > 0) {
    addBlocker(
      "unresolved_acceptance",
      `产品验收未通过：${unresolvedProductCaseIds.join(", ")}`,
      unresolvedProductCaseIds,
    );
  }
  const unresolvedReviewCaseIds = run.acceptance
    .filter(
      (item) =>
        isReviewGateAcceptanceCase(item) &&
        resolveAgentTeamAcceptanceObservedOutcome(item) !== "pass",
    )
    .map((item) => item.caseId);
  if (unresolvedReviewCaseIds.length > 0) {
    addBlocker(
      "review_gate",
      `Code Review 未通过：${unresolvedReviewCaseIds.join(", ")}`,
      unresolvedReviewCaseIds,
    );
  }
  if (run.pendingFindingDecision) {
    addBlocker("pending_finding", "存在待裁决 review finding");
  }
  if ((run.loop.repairCycles ?? []).length > 0) {
    addBlocker(
      "repair_cycle",
      "存在未收口 repair cycle",
      Array.from(
        new Set(run.loop.repairCycles.flatMap((cycle) => cycle.caseIds)),
      ),
    );
  }
  if (run.frameworkRepair?.result === "blocked") {
    addBlocker(
      "framework_repair",
      "framework repair 尚未恢复",
      run.frameworkRepair.target.caseIds,
    );
  }
  if (run.activeWorkerDispatch || run.activeWorkerRole) {
    addBlocker("active_dispatch", "仍有 active worker dispatch");
  }
  if (
    unresolvedProductCaseIds.length === 0 &&
    unresolvedReviewCaseIds.length === 0 &&
    run.reviewCheckpoint &&
    run.reviewCheckpoint.checkpoints.length > 0 &&
    run.reviewCheckpoint.finalReviewedCommit !==
      run.reviewCheckpoint.lastReviewedCommit
  ) {
    addBlocker("final_review", "最新 checkpoint 尚未完成 final review");
  }
  if (blockers.length > 0) {
    return { ready: false, blockers };
  }
  const exceptions = completionExceptions(run);
  return {
    ready: true,
    result: exceptions.length > 0 ? "completed_with_exceptions" : "succeeded",
    exceptions,
  };
}

export function appendAgentTeamCompletionOutcome(
  run: AgentTeamRun,
  outcome: AgentTeamCompletionOutcome,
): Pick<AgentTeamRun, "completionOutcome" | "completionHistory"> {
  if (run.completionOutcome?.id === outcome.id) {
    return {
      completionOutcome: run.completionOutcome,
      completionHistory: run.completionHistory ?? [run.completionOutcome],
    };
  }
  return {
    completionOutcome: outcome,
    completionHistory: [...(run.completionHistory ?? []), outcome],
  };
}

function completionExceptions(
  run: AgentTeamRun,
): AgentTeamCompletionException[] {
  const findingExceptions = (run.findingDecisions ?? [])
    .filter(
      (decision) =>
        decision.disposition === "out_of_scope" ||
        decision.disposition === "waived",
    )
    .map((decision) => ({
      kind: "finding_disposition" as const,
      decisionId: decision.id,
    }));
  const acceptanceExceptions = run.acceptance.flatMap((item) => {
    const decision = resolveAgentTeamAcceptanceDecision(run, item);
    return decision
      ? [
          {
            kind: "acceptance_disposition" as const,
            decisionId: decision.id,
          },
        ]
      : [];
  });
  return [...findingExceptions, ...acceptanceExceptions];
}

function projectLegacyCompletionOutcome(
  run: AgentTeamRun,
): AgentTeamCompletionOutcome | null {
  if (run.status !== "done") {
    return null;
  }
  const legacyCaseIds = run.acceptance
    .filter(
      (item) =>
        resolveAgentTeamAcceptanceObservedOutcome(item) !== "pass" &&
        !resolveAgentTeamAcceptanceDecision(run, item),
    )
    .map((item) => item.caseId);
  const recordedExceptions = completionExceptions(run);
  const exceptions: AgentTeamCompletionException[] = [
    ...recordedExceptions,
    ...(legacyCaseIds.length > 0
      ? [
          {
            kind: "legacy_manual_completion" as const,
            caseIds: legacyCaseIds,
          },
        ]
      : []),
  ];
  return {
    id: `legacy_${run.runId}_${run.status}_${run.updatedAt}`,
    result: exceptions.length > 0 ? "completed_with_exceptions" : "succeeded",
    exceptions,
    trigger: "operator_finalize",
    finalizedAt: run.updatedAt,
  };
}
