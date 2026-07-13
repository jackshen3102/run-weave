import type {
  AgentTeamAcceptanceCase,
  AgentTeamRun,
  AgentTeamWorkerOutbox,
  AgentTeamWorkerRole,
} from "@runweave/shared/agent-team";
import { buildWorkerRecheckPrompt } from "./prompt-builders";
import { acceptanceCasesForRole } from "./service-acceptance-policy";
import { AgentTeamExecutionService } from "./service-execution";
import { resolveAgentTeamTerminal } from "./service-run-policy";
import {
  createActiveWorkerDispatch,
  findWorkerByRole,
  setActiveWorker,
} from "./service-workflow-policy";

export abstract class AgentTeamSerialDispatchService extends AgentTeamExecutionService {
  protected async finalizeReviewCheckpoint(
    run: AgentTeamRun,
    outbox: AgentTeamWorkerOutbox,
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
        return this.updateRun(run, {
          reviewCheckpoint: {
            ...state,
            pendingReview: null,
            finalReviewedCommit: state.lastReviewedCommit,
          },
          logs: [
            ...run.logs,
            `最终全量 review 通过：${state.taskBaseCommit}..${state.lastReviewedCommit}`,
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
      return this.updateRun(run, {
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

  protected async dispatchSerialWorker(
    run: AgentTeamRun,
    role: AgentTeamWorkerRole,
    options: {
      cases: AgentTeamAcceptanceCase[];
      log: string;
      triggerSummary?: string | null;
      reviewScope?: "full" | "incremental" | "final";
    },
  ): Promise<AgentTeamRun> {
    const session = this.terminalSessionManager.getSession(
      run.terminalSessionId,
    );
    if (!session) {
      return run;
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
        });
        dispatchRun = await this.updateRun(run, {
          reviewCheckpoint: {
            ...run.reviewCheckpoint,
            pendingReview: reviewTarget,
          },
        });
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
      return run;
    }
    const terminal = resolveAgentTeamTerminal(run.terminal);
    await this.agentReadiness.ensureAgentReady(session, terminal, {
      panelId: worker.panelId,
    });
    const outboxPath = this.paths.workerOutboxRelativePath(
      dispatchRun.terminalSessionId,
      worker,
    );
    const outboxMtimeMs = await this.readWorkerOutboxMtimeMs(session, worker);
    const now = new Date().toISOString();
    await this.promptSender.sendPromptToPane(
      session,
      buildWorkerRecheckPrompt({
        run: dispatchRun,
        worker,
        cases: options.cases,
        outboxPath,
        triggerSummary: options.triggerSummary ?? null,
      }),
      { panelId: worker.panelId },
    );

    const caseIds = new Set(options.cases.map((item) => item.caseId));
    return this.updateRun(dispatchRun, {
      activeWorkerRole: role,
      activeWorkerDispatch: createActiveWorkerDispatch(
        worker,
        now,
        outboxMtimeMs,
        dispatchRun.loop.round,
        reviewTarget,
      ),
      workers: setActiveWorker(dispatchRun.workers, role),
      acceptance: dispatchRun.acceptance.map((item) =>
        caseIds.has(item.caseId)
          ? {
              ...item,
              status: "pending" as const,
              consecutiveFail: 0,
              resultSummary: null,
              bouncedToPanelId: null,
              recheckRequestedAt: now,
              recheckWorkerPanelId: worker.panelId,
              recheckWorkerRole: worker.role,
              recheckOutboxMtimeMs: outboxMtimeMs,
              recheckAttempt: 1,
            }
          : item,
      ),
      logs: [
        ...dispatchRun.logs,
        `${options.log}（${role} pane ${worker.panelId}）`,
      ],
    });
  }
}
