import type {
  AgentTeamAcceptanceCase,
  AgentTeamRun,
  AgentTeamWorkerOutbox,
  AgentTeamWorkerRole,
} from "@runweave/shared/agent-team";
import { buildWorkerRecheckPrompt } from "./prompt-builders";
import { incrementRepairAttempts } from "./repair-loop";
import { acceptanceCasesForRole } from "./service-acceptance-policy";
import { AgentTeamExecutionService } from "./service-execution";
import {
  createActiveWorkerDispatch,
  findWorkerByRole,
  setActiveWorker,
} from "./service-workflow-policy";

export abstract class AgentTeamSerialDispatchService extends AgentTeamExecutionService {
  protected async finalizeReviewCheckpoint(
    run: AgentTeamRun,
    outbox: AgentTeamWorkerOutbox,
    options: { persist?: boolean } = {},
  ): Promise<AgentTeamRun> {
    const state = run.reviewCheckpoint;
    const target = state?.pendingReview;
    if (!state || !target) {
      return this.pauseForCheckpointError(
        run,
        "review pass 缺少 pending review target",
      );
    }
    try {
      await this.assertVerificationSourcesUnchanged(run);
      if (target.scope === "final") {
        await this.reviewCheckpointGit.assertReviewTargetUnchanged(
          state,
          target,
        );
        const finalReviewedCommit =
          target.targetCommit ?? state.lastReviewedCommit;
        return this.applyReviewCheckpointPatch(run, options.persist, {
          reviewCheckpoint: {
            ...state,
            lastReviewedCommit: finalReviewedCommit,
            pendingReview: null,
            finalReviewedCommit,
          },
          logs: [
            ...run.logs,
            `最终全量 review 通过：${state.taskBaseCommit}..${finalReviewedCommit}`,
          ],
        });
      }
      const checkpointParams = {
        runId: run.runId,
        reviewRound: run.loop.round,
        reviewerPanelId: outbox.panelId ?? null,
        state,
        target,
      };
      const recovered =
        await this.reviewCheckpointGit.recoverCommittedCheckpoint(
          checkpointParams,
        );
      if (!recovered) {
        await this.reviewCheckpointGit.assertReviewTargetUnchanged(
          state,
          target,
        );
      }
      const checkpoint =
        recovered ??
        (await this.reviewCheckpointGit.commitReviewedTarget(checkpointParams));
      const invalidatePassedBehavior = acceptanceCasesForRole(
        run,
        "behavior_verify",
      ).every((item) => item.status === "pass");
      return this.applyReviewCheckpointPatch(run, options.persist, {
        reviewCheckpoint: {
          ...state,
          lastReviewedCommit: checkpoint.commit,
          pendingReview: null,
          checkpoints: [...state.checkpoints, checkpoint],
          finalReviewedCommit: null,
        },
        acceptance: invalidatePassedBehavior
          ? run.acceptance.map((item) =>
              acceptanceCasesForRole(run, "behavior_verify").some(
                (behaviorCase) => behaviorCase.caseId === item.caseId,
              )
                ? {
                    ...item,
                    status: "pending" as const,
                    resultSummary: null,
                    skip: null,
                    skipReason: null,
                  }
                : item,
            )
          : run.acceptance,
        logs: [
          ...run.logs,
          `Review checkpoint C${checkpoint.sequence} 已提交：${checkpoint.commit}`,
        ],
      });
    } catch (error) {
      return this.pauseForCheckpointError(
        run,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private applyReviewCheckpointPatch(
    run: AgentTeamRun,
    persist: boolean | undefined,
    patch: Partial<
      Pick<AgentTeamRun, "reviewCheckpoint" | "acceptance" | "logs">
    >,
  ): Promise<AgentTeamRun> | AgentTeamRun {
    if (persist !== false) {
      return this.updateRun(run, patch);
    }
    return { ...run, ...patch };
  }

  protected async dispatchSerialWorker(
    run: AgentTeamRun,
    role: AgentTeamWorkerRole,
    options: {
      cases: AgentTeamAcceptanceCase[];
      log: string;
      triggerSummary?: string | null;
      reviewScope?: "full" | "incremental" | "final";
      acceptedRepairKeys?: string[];
      reviewChallenge?: { repairKeys: string[]; reason: string };
      checkpointAllowedDirtyPaths?: string[];
      checkpointExpectedHeadCommit?: string;
      checkpointRebasedCommit?: string;
    },
  ): Promise<AgentTeamRun> {
    const session = this.terminalSessionManager.getSession(
      run.terminalSessionId,
    );
    if (!session) {
      return this.pauseForWorkerDispatchError(
        run,
        role,
        `readiness 失败：terminal session ${run.terminalSessionId} 不存在`,
      );
    }
    let dispatchRun = run;
    let reviewTarget = null;
    if (role === "code_review" && run.reviewCheckpoint) {
      try {
        await this.assertVerificationSourcesUnchanged(run);
        const scope =
          options.reviewScope ??
          (run.reviewCheckpoint.checkpoints.length === 0
            ? "full"
            : "incremental");
        reviewTarget = await this.reviewCheckpointGit.prepareReviewTarget({
          state: run.reviewCheckpoint,
          scope,
          planSha256: run.verification?.planSha256 ?? null,
          testCaseSha256: this.effectiveTestCaseSha256(run.verification),
          expectedHeadCommit: options.checkpointExpectedHeadCommit,
          rebasedCheckpointCommit: options.checkpointRebasedCommit,
        });
        dispatchRun = {
          ...run,
          reviewCheckpoint: {
            ...run.reviewCheckpoint,
            pendingReview: reviewTarget,
          },
        };
      } catch (error) {
        return this.pauseForCheckpointError(
          run,
          error instanceof Error ? error.message : String(error),
        );
      }
    } else if (role === "behavior_verify" && run.reviewCheckpoint) {
      try {
        await this.assertVerificationSourcesUnchanged(run);
        await this.reviewCheckpointGit.assertCheckpointHead(
          run.reviewCheckpoint,
          options.checkpointAllowedDirtyPaths,
          options.checkpointExpectedHeadCommit,
          options.checkpointRebasedCommit,
        );
      } catch (error) {
        return this.pauseForCheckpointError(
          run,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const worker = findWorkerByRole(dispatchRun.workers, role);
    if (!worker?.panelId) {
      return this.pauseForWorkerDispatchError(
        run,
        role,
        "readiness 失败：worker pane 不存在",
      );
    }
    const outboxPath = this.paths.workerOutboxRelativePath(
      dispatchRun.terminalSessionId,
      worker,
    );
    const outboxMtimeMs = await this.readWorkerOutboxMtimeMs(session, worker);
    const now = new Date().toISOString();
    const caseIds = new Set(options.cases.map((item) => item.caseId));
    const acceptedRepairKeys = options.acceptedRepairKeys ?? [];
    const activeWorkerDispatch = createActiveWorkerDispatch(
      worker,
      now,
      outboxMtimeMs,
      dispatchRun.loop.round,
      reviewTarget,
      role === "behavior_verify" && run.reviewCheckpoint
        ? {
            verifiedCheckpointCommit:
              options.checkpointExpectedHeadCommit ??
              run.reviewCheckpoint.lastReviewedCommit,
            checkpointAllowedDirtyPaths:
              options.checkpointAllowedDirtyPaths ?? [],
            checkpointRebasedCommit: options.checkpointRebasedCommit ?? null,
          }
        : {},
    );
    const persistedRun = await this.updateRun(run, {
      reviewCheckpoint: dispatchRun.reviewCheckpoint,
      loop:
        acceptedRepairKeys.length > 0
          ? incrementRepairAttempts(run.loop, acceptedRepairKeys)
          : run.loop,
      activeWorkerRole: role,
      activeWorkerDispatch,
      workerDispatchProtocolVersion: 1,
      consumedWorkerDispatches: run.consumedWorkerDispatches ?? [],
      workers: setActiveWorker(dispatchRun.workers, role),
      acceptance: dispatchRun.acceptance.map((item) =>
        caseIds.has(item.caseId)
          ? {
              ...item,
              status: "pending" as const,
              lastRunStatus: "pending" as const,
              skip: null,
              skipReason: null,
              consecutiveFail: 0,
              resultSummary: null,
              reproduction: null,
              bouncedToPanelId: null,
              recheckRequestedAt: now,
              recheckDispatchId: activeWorkerDispatch.dispatchId ?? null,
              recheckWorkerPanelId: worker.panelId,
              recheckWorkerRole: worker.role,
              recheckOutboxMtimeMs: outboxMtimeMs,
              recheckAttempt: 1,
            }
          : item,
      ),
      logs: [
        ...dispatchRun.logs,
        ...(acceptedRepairKeys.length > 0
          ? [
              `code 修复交接证据通过，repair attempts +1：${acceptedRepairKeys.join(", ")}`,
            ]
          : []),
        `${options.log}（${role} pane ${worker.panelId}）`,
      ],
    });
    const workerPrompt = buildWorkerRecheckPrompt({
      run: persistedRun,
      worker,
      cases: options.cases,
      outboxPath,
      triggerSummary: options.triggerSummary ?? null,
      reviewChallenge: options.reviewChallenge ?? null,
    });
    try {
      await this.submitWorkerDispatchPrompt(
        persistedRun,
        session,
        run.terminal,
        worker,
        workerPrompt,
      );
    } catch (error) {
      return this.pauseForWorkerDispatchError(
        {
          ...persistedRun,
          reviewCheckpoint: run.reviewCheckpoint,
          workers: run.workers,
          acceptance: run.acceptance,
          loop: run.loop,
          logs: run.logs,
        },
        role,
        `readiness 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return persistedRun;
  }
}
