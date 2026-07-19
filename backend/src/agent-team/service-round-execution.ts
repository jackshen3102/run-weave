import { randomUUID } from "node:crypto";
import type {
  AgentTeamAcceptanceCase,
  AgentTeamActiveWorkerDispatch,
  AgentTeamPendingFindingDecision,
  AgentTeamRun,
  AgentTeamStatus,
  AgentTeamWorkerOutbox,
  AgentTeamWorkerRole,
} from "@runweave/shared/agent-team";
import { AgentTeamError } from "./errors";
import { buildEscalationReason, foldRound, shouldEscalate } from "./loop";
import {
  buildRepairEscalationReason,
  foldRepairGateResult,
  type AgentTeamRepairTarget,
} from "./repair-loop";
import {
  acceptanceCasesForRole,
  behaviorVerificationCasesForDispatch,
  ensureWorkerGateAcceptance,
  hasRolePassed,
  isReviewGateAcceptanceCase,
} from "./service-acceptance-policy";
import { resolveBounceSelection } from "./service-bounce-policy";
import { shouldContinueBeforeNoProgressEscalation } from "./service-round-continuation-policy";
import { pendingDecisionFromReviewCycle } from "./service-execution-support";
import { AgentTeamServiceSupport } from "./service-support";
import {
  appendAgentTeamCompletionOutcome,
  evaluateAgentTeamCompletion,
} from "./service-completion-policy";

export abstract class AgentTeamRoundExecutionService extends AgentTeamServiceSupport {
  protected abstract dispatchSerialWorker(
    run: AgentTeamRun,
    role: AgentTeamWorkerRole,
    options: {
      cases: AgentTeamAcceptanceCase[];
      log: string;
      triggerSummary?: string | null;
      reviewScope?: "full" | "incremental" | "final";
      acceptedRepairKeys?: string[];
      reviewChallenge?: { repairKeys: string[]; reason: string };
    },
  ): Promise<AgentTeamRun>;

  protected abstract bounceFailuresToCode(
    run: AgentTeamRun,
    caseIds: string[],
    repairKeys?: string[],
  ): Promise<AgentTeamRun>;

  protected async applyRound(
    run: AgentTeamRun,
    params: {
      acceptanceResults?: AgentTeamWorkerOutbox["acceptanceResults"];
      forceBounceCaseIds?: string[];
      repairTargets?: AgentTeamRepairTarget[];
      completedWorkerRole?: AgentTeamWorkerRole | null;
      completedWorkerSummary?: string | null;
    },
  ): Promise<AgentTeamRun> {
    if (run.phase !== "executing") {
      throw new AgentTeamError(409, "Run is not running a loop");
    }
    if (run.status === "need_human") {
      // Frozen: do not advance the loop until the human resumes.
      return run;
    }
    const runWithGates = {
      ...run,
      acceptance: ensureWorkerGateAcceptance(run.workers, run.acceptance),
    };
    const recordedAt = new Date().toISOString();
    const folded = foldRound(runWithGates, { ...params, recordedAt });
    const repairFolded = foldRepairGateResult({
      loop: folded.loop,
      completedRole: params.completedWorkerRole,
      acceptanceResults: params.acceptanceResults ?? [],
      targets: params.repairTargets ?? [],
      round: run.loop.round,
    });
    const logs = [...runWithGates.logs];
    if (folded.reviewStateChanged && folded.hadProgress) {
      logs.push(`round ${run.loop.round} 有进展，noProgress 计数清零`);
    } else if (folded.reviewStateChanged && params.acceptanceResults?.length) {
      logs.push(
        `round ${run.loop.round} 无进展，noProgress=${folded.loop.noProgressCount}/${folded.loop.maxNoProgress}`,
      );
    }

    let status: AgentTeamStatus = "running";
    let loop = repairFolded.loop;
    let workers = run.workers;
    let activeWorkerRole = run.activeWorkerRole ?? null;
    // This completion consumed the current dispatch. A follow-up bounce or
    // serial worker dispatch will install a new boundary below.
    let activeWorkerDispatch: AgentTeamActiveWorkerDispatch | null = null;
    let pendingFindingDecision: AgentTeamPendingFindingDecision | null = null;
    // verify_first can finish its first pass all-green with zero code activity.
    // The synthetic review gate then never gets dispatched (code_review only
    // runs after code), which would strand the run in `running`. When no code or
    // code_review dispatch has ever been consumed, there is no diff to review, so
    // the gate is vacuously satisfied. Once any code/code_review work happens the
    // gate flows through the normal review path instead.
    const codeReviewEverRan = (run.consumedWorkerDispatches ?? []).some(
      (receipt) => receipt.role === "code" || receipt.role === "code_review",
    );
    let foldedAcceptance = folded.acceptance;
    if (
      params.completedWorkerRole === "behavior_verify" &&
      !codeReviewEverRan &&
      foldedAcceptance.length > 0
    ) {
      const nonGatePassed = foldedAcceptance
        .filter((item) => !isReviewGateAcceptanceCase(item))
        .every((item) => item.status === "pass");
      if (nonGatePassed) {
        foldedAcceptance = foldedAcceptance.map((item) =>
          isReviewGateAcceptanceCase(item) && item.status !== "pass"
            ? {
                ...item,
                latestObservation: {
                  outcome: "pass" as const,
                  dispatchId: null,
                  recordedAt,
                },
                status: "pass" as const,
                lastRunStatus: "pass" as const,
                resultSummary: "无代码改动，Code Review 门禁无审查对象",
              }
            : item,
        );
      }
    }
    const automaticBehaviorCases = behaviorVerificationCasesForDispatch({
      ...run,
      acceptance: foldedAcceptance,
    });
    const shouldContinueSerially = shouldContinueBeforeNoProgressEscalation(
      { ...run, loop, acceptance: foldedAcceptance },
      params.completedWorkerRole,
      automaticBehaviorCases,
    );
    const blockedBehaviorCases =
      params.completedWorkerRole === "behavior_verify" &&
      automaticBehaviorCases.length === 0 &&
      !params.acceptanceResults?.some((result) => result.status === "fail")
        ? foldedAcceptance.filter(
            (item) =>
              item.status === "pending" &&
              item.lastRunStatus === "skipped" &&
              (!item.skip ||
                item.skip.code === "environment" ||
                item.skip.code === "not_applicable"),
          )
        : [];
    const completionEvaluation = evaluateAgentTeamCompletion({
      ...run,
      status: "running",
      loop,
      acceptance: foldedAcceptance,
      activeWorkerRole: null,
      activeWorkerDispatch: null,
      pendingFindingDecision,
    });
    const needsFinalReview =
      !completionEvaluation.ready &&
      completionEvaluation.blockers.length === 1 &&
      completionEvaluation.blockers[0]?.code === "final_review";
    const reachesCompletionGate = completionEvaluation.ready;
    let fixtureCleanupHistory = run.fixtureCleanupHistory ?? [];
    let fixtureCleanupBlocked = false;
    if (
      (run.runKind ?? "primary") === "primary" &&
      (reachesCompletionGate ||
        params.completedWorkerRole === "behavior_verify")
    ) {
      const cleanup = await this.reconcileOwnedFixtureResources(
        run,
        reachesCompletionGate
          ? null
          : (run.activeWorkerDispatch?.dispatchId ?? null),
        reachesCompletionGate
          ? `owner Run ${run.runId} reached completion gate`
          : `behavior dispatch ${run.activeWorkerDispatch?.dispatchId ?? "unknown"} completed`,
      );
      fixtureCleanupHistory = [...fixtureCleanupHistory, cleanup];
      fixtureCleanupBlocked =
        reachesCompletionGate && cleanup.status !== "completed";
      if (!reachesCompletionGate && cleanup.status !== "completed") {
        logs.push(
          `⚠ behavior dispatch fixture cleanup 待收口：${formatFixtureCleanupSummary(cleanup)}`,
        );
      }
    }
    if (fixtureCleanupBlocked) {
      const cleanup = fixtureCleanupHistory.at(-1)!;
      const reason = `fixture cleanup 未归零：${formatFixtureCleanupSummary(cleanup)}`;
      loop = { ...repairFolded.loop, escalated: true, lastReason: reason };
      status = "need_human";
      workers = run.workers.map((worker) => ({ ...worker, frozen: true }));
      activeWorkerRole = null;
      activeWorkerDispatch = null;
      logs.push(`⏸ ${reason}`);
    } else if (reachesCompletionGate) {
      status = "done";
      workers = run.workers.map((worker) => ({ ...worker, frozen: true }));
      activeWorkerRole = null;
      activeWorkerDispatch = null;
      logs.push(`✅ 所有验收用例通过，run 完成`);
    } else if (blockedBehaviorCases.length > 0) {
      const reason = `behavior_verify 结构化跳过需要恢复或裁决：${blockedBehaviorCases.map((item) => `${item.caseId}(${item.skip?.code ?? "legacy"})`).join(", ")}`;
      loop = { ...repairFolded.loop, escalated: true, lastReason: reason };
      status = "need_human";
      workers = run.workers.map((worker) => ({ ...worker, frozen: true }));
      activeWorkerRole = null;
      activeWorkerDispatch = null;
      logs.push(`⏸ ${reason}`);
    } else if (repairFolded.exhausted.length > 0) {
      const reason = buildRepairEscalationReason(repairFolded.exhausted);
      loop = { ...repairFolded.loop, escalated: true, lastReason: reason };
      status = "need_human";
      workers = run.workers.map((worker) => ({ ...worker, frozen: true }));
      activeWorkerRole = null;
      activeWorkerDispatch = null;
      pendingFindingDecision = pendingDecisionFromReviewCycle(
        repairFolded.exhausted,
        reason,
      );
      logs.push(`⏸ ${reason}`);
    } else if (
      shouldEscalate(repairFolded.loop) &&
      !shouldContinueSerially
    ) {
      const reason = buildEscalationReason(repairFolded.loop, foldedAcceptance);
      loop = { ...repairFolded.loop, escalated: true, lastReason: reason };
      status = "need_human";
      // Freeze all worker panes: stop injecting further rounds.
      workers = run.workers.map((worker) => ({ ...worker, frozen: true }));
      activeWorkerRole = null;
      activeWorkerDispatch = null;
      pendingFindingDecision = pendingDecisionFromReviewCycle(
        repairFolded.loop.repairCycles,
        reason,
      );
      logs.push(`⏸ ${reason}`);
    }

    const completionPatch =
      status === "done" && completionEvaluation.ready
        ? appendAgentTeamCompletionOutcome(run, {
            id: randomUUID(),
            result: completionEvaluation.result,
            exceptions: completionEvaluation.exceptions,
            trigger: "automatic",
            finalizedAt: new Date().toISOString(),
          })
        : {
            completionOutcome: null,
            completionHistory: run.completionHistory ?? [],
          };
    const transitionPatch = {
      status,
      loop,
      acceptance: foldedAcceptance,
      workers,
      activeWorkerRole,
      activeWorkerDispatch,
      pendingFindingDecision,
      fixtureCleanupHistory,
      ...completionPatch,
      workerDispatchProtocolVersion: 1 as const,
      consumedWorkerDispatches: run.consumedWorkerDispatches ?? [],
      logs,
    };
    const nextRun: AgentTeamRun = { ...run, ...transitionPatch };

    if (status === "running" && needsFinalReview) {
      return this.dispatchSerialWorker(nextRun, "code_review", {
        cases: acceptanceCasesForRole(nextRun, "code_review"),
        log: "behavior_verify 全部通过，启动最终全量 code_review",
        triggerSummary: params.completedWorkerSummary ?? null,
        reviewScope: "final",
      });
    }

    // Stable failures use the case marker as a debounce. A newly consumed gate
    // result is already idempotent at the dispatch receipt boundary, so it may
    // force the same case through a new repair cycle after an earlier bounce.
    const bounceSelection =
      status === "running"
        ? resolveBounceSelection(
            nextRun,
            params.forceBounceCaseIds ?? [],
            params.repairTargets ?? [],
          )
        : { caseIds: [], repairKeys: [] };
    if (bounceSelection.caseIds.length > 0) {
      return this.bounceFailuresToCode(
        nextRun,
        bounceSelection.caseIds,
        bounceSelection.repairKeys,
      );
    }
    if (
      status === "running" &&
      nextRun.phase === "executing" &&
      params.completedWorkerRole === "code_review" &&
      hasRolePassed(nextRun, "code_review")
    ) {
      return this.dispatchSerialWorker(nextRun, "behavior_verify", {
        cases: behaviorVerificationCasesForDispatch(nextRun),
        log: "code_review 通过，启动 behavior_verify",
        triggerSummary: params.completedWorkerSummary ?? null,
      });
    }
    if (
      status === "running" &&
      nextRun.phase === "executing" &&
      params.completedWorkerRole === "behavior_verify" &&
      automaticBehaviorCases.length > 0
    ) {
      return this.dispatchSerialWorker(nextRun, "behavior_verify", {
        cases: automaticBehaviorCases,
        log: "behavior_verify 依赖解除，续跑最小 Case 闭包",
        triggerSummary: params.completedWorkerSummary ?? null,
      });
    }
    return this.updateRun(run, transitionPatch);
  }
}

function formatFixtureCleanupSummary(
  cleanup: NonNullable<AgentTeamRun["fixtureCleanupHistory"]>[number],
): string {
  const blockedSessions = cleanup.devSessions
    .filter((session) => session.error)
    .map((session) => session.devSessionId);
  return [
    `ownedLiveFixtureRuns=${cleanup.ownedLiveFixtureRunIds.length}`,
    `blockedDevSessions=${blockedSessions.length}`,
    blockedSessions.length > 0 ? `sessions=${blockedSessions.join(",")}` : null,
    cleanup.errors.length > 0 ? cleanup.errors.join("; ") : null,
  ]
    .filter((item): item is string => Boolean(item))
    .join("；");
}
