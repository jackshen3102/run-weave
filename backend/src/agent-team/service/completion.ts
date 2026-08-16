import type {
  AgentTeamAcceptanceCase,
  AgentTeamOutboxHistoryRecord,
  AgentTeamRun,
  AgentTeamWorker,
  AgentTeamWorkerOutbox,
} from "@runweave/shared/agent-team";
import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import type { TerminalSessionRecord } from "../../terminal/manager/manager";
import { buildCodeFixHandoffCorrectionPrompt } from "../prompt/builders";
import { agentTeamLogger } from "./context";
import { logReconciledCompletion } from "./completion-logging";
import { AgentTeamCompletionPreparationService } from "./completion-preparation";
import type { AgentTeamCompletionSignalSource } from "./types";
import { validateCodeFixHandoff } from "../repair/loop";
import {
  acceptanceCasesForRole,
  ensureWorkerGateAcceptance,
  expandRecheckCasesForFailures,
  isImplementationWorkerOutbox,
  resolveRecheckDispatches,
} from "./acceptance-policy";
import {
  parseWorkerRole,
  shouldDispatchNextSerialWorker,
} from "./workflow-policy";

export abstract class AgentTeamCompletionService extends AgentTeamCompletionPreparationService {
  protected abstract markRecheckDispatchFailed(
    run: AgentTeamRun,
    session: TerminalSessionRecord,
    worker: AgentTeamWorker,
    cases: AgentTeamAcceptanceCase[],
    attempt: number,
  ): Promise<AgentTeamRun>;

  protected async reconcileCompletionEvent(
    event: Extract<TerminalEventEnvelope, { kind: "completion" }>,
    source: AgentTeamCompletionSignalSource,
  ): Promise<boolean> {
    if (!event.projectId) {
      return false;
    }
    const run = await this.runStore.getRunByTerminalSession(
      event.projectId,
      event.terminalSessionId,
    );
    if (!run || run.phase !== "executing" || run.status !== "running") {
      return false;
    }
    this.incrementPendingCompletionRound(run.runId);
    return this.enqueue(run.runId, async () => {
      try {
        const latest = await this.runStore.getRun(run.runId);
        if (
          !latest ||
          latest.phase !== "executing" ||
          latest.status !== "running"
        ) {
          return false;
        }
        const contextResult = await this.resolveCompletionContext(
          latest,
          event,
          source,
        );
        if (contextResult.status === "stop") {
          return contextResult.handled;
        }
        const context = contextResult.value;
        const archivedResult = await this.archiveAndVerifyCompletion(
          latest,
          event,
          context,
        );
        if (archivedResult.status === "stop") {
          return archivedResult.handled;
        }
        const { transitionRun, archivedOutbox } = archivedResult.value;
        if (
          context.outbox.role === "behavior_verify" &&
          latest.reviewCheckpoint
        ) {
          const expectedCheckpointCommit =
            latest.activeWorkerDispatch?.verifiedCheckpointCommit ??
            latest.reviewCheckpoint.lastReviewedCommit;
          if (
            context.outbox.verifiedCheckpointCommit !== expectedCheckpointCommit
          ) {
            await this.pauseForCheckpointError(
              transitionRun,
              `behavior outbox checkpoint 不匹配：expected ${expectedCheckpointCommit}，actual ${context.outbox.verifiedCheckpointCommit ?? "null"}`,
            );
            return true;
          }
          try {
            await this.assertVerificationSourcesUnchanged(latest);
            await this.reviewCheckpointGit.assertCheckpointHead(
              latest.reviewCheckpoint,
              latest.activeWorkerDispatch?.checkpointAllowedDirtyPaths,
              expectedCheckpointCommit,
              latest.activeWorkerDispatch?.checkpointRebasedCommit ?? undefined,
            );
          } catch (error) {
            await this.pauseForCheckpointError(
              transitionRun,
              error instanceof Error ? error.message : String(error),
            );
            return true;
          }
        }
        const contractResult = await this.validateCompletionContracts(
          latest,
          transitionRun,
          context,
        );
        if (contractResult.status === "stop") {
          return contractResult.handled;
        }
        const initialRound = contractResult.value;
        const { activeWorker, outbox, outboxMtimeMs } = context;
        const shouldDispatchRecheck = this.hasBouncedCasesForWorker(
          latest,
          outbox,
        );
        const shouldDispatchSerial = shouldDispatchNextSerialWorker(
          latest,
          outbox,
        );
        if (
          !initialRound.acceptanceResults.length &&
          !shouldDispatchRecheck &&
          !shouldDispatchSerial
        ) {
          await this.pauseForRepairProtocolError(
            transitionRun,
            `${outbox.role} outbox 未包含可消费的验收结果`,
          );
          return true;
        }
        const serialRun = await this.dispatchNextSerialWorkerFromCompletion(
          transitionRun,
          outbox,
        );
        if (serialRun) {
          logReconciledCompletion(
            source,
            latest,
            activeWorker,
            outboxMtimeMs,
            initialRound.acceptanceResults.length,
          );
          return true;
        }
        let roundRun = transitionRun;
        if (
          outbox.role === "code_review" &&
          latest.reviewCheckpoint &&
          initialRound.acceptanceResults.length > 0 &&
          initialRound.acceptanceResults.every(
            (result) => result.status === "pass",
          )
        ) {
          if (latest.reviewCheckpoint.pendingReview) {
            const finalized = await this.finalizeReviewCheckpoint(
              transitionRun,
              outbox,
              { persist: false },
            );
            if (finalized.status !== "running") {
              return true;
            }
            roundRun = finalized;
          } else if (archivedOutbox.created) {
            await this.pauseForCheckpointError(
              transitionRun,
              "review pass 缺少 pending review target",
            );
            return true;
          }
        }
        const round = this.resolveOutboxRound(roundRun, outbox);
        if (!round.acceptanceResults.length) {
          await this.dispatchBouncedCasesForRecheck(roundRun, outbox);
          logReconciledCompletion(
            source,
            latest,
            activeWorker,
            outboxMtimeMs,
            0,
          );
          return true;
        }
        await this.applyRound(roundRun, {
          acceptanceResults: round.acceptanceResults,
          forceBounceCaseIds: round.forceBounceCaseIds,
          repairTargets: round.repairTargets,
          completedWorkerRole: parseWorkerRole(outbox.role),
          completedWorkerSummary: outbox.summary,
        });
        logReconciledCompletion(
          source,
          latest,
          activeWorker,
          outboxMtimeMs,
          round.acceptanceResults.length,
        );
        return true;
      } finally {
        this.decrementPendingCompletionRound(run.runId);
      }
    });
  }

  protected withConsumedWorkerDispatch(
    run: AgentTeamRun,
    history: AgentTeamOutboxHistoryRecord,
  ): AgentTeamRun {
    if (
      run.consumedWorkerDispatches?.some(
        (receipt) => receipt.dispatchId === history.dispatchId,
      )
    ) {
      return run;
    }
    return {
      ...run,
      workerDispatchProtocolVersion: 1,
      consumedWorkerDispatches: [
        ...(run.consumedWorkerDispatches ?? []),
        {
          dispatchId: history.dispatchId,
          role: history.role,
          round: history.round,
          contentSha256: history.contentSha256,
          consumedAt: new Date().toISOString(),
        },
      ],
    };
  }

  protected async validateCodeHandoff(
    latest: AgentTeamRun,
    transitionRun: AgentTeamRun,
    activeWorker: AgentTeamWorker,
    outbox: AgentTeamWorkerOutbox,
    outboxMtimeMs: number | null,
  ): Promise<"ready" | "stopped"> {
    const handoff = validateCodeFixHandoff(latest, outbox);
    if (handoff.status === "reviewer_reproduction_required") {
      await this.dispatchSerialWorker(transitionRun, "code_review", {
        cases: acceptanceCasesForRole(latest, "code_review"),
        log: "code 无法复现重复 review finding，回派 reviewer 现场举证",
        triggerSummary: handoff.reason,
        reviewChallenge: {
          repairKeys: handoff.repairKeys,
          reason: handoff.reason,
        },
      });
      return "stopped";
    }
    if (handoff.status === "blocked") {
      await this.pauseForRepairProtocolError(transitionRun, handoff.reason);
      return "stopped";
    }
    if (handoff.status === "invalid") {
      await this.handleProtocolCorrection(
        transitionRun,
        activeWorker,
        outboxMtimeMs,
        handoff.errors,
        (run) =>
          buildCodeFixHandoffCorrectionPrompt({
            run,
            errors: handoff.errors,
          }),
        "code fixVerifications",
      );
      return "stopped";
    }
    return "ready";
  }

  protected hasBouncedCasesForWorker(
    run: AgentTeamRun,
    outbox: AgentTeamWorkerOutbox,
  ): boolean {
    return this.findBouncedCasesForWorker(run, outbox).length > 0;
  }

  protected findBouncedCasesForWorker(
    run: AgentTeamRun,
    outbox: AgentTeamWorkerOutbox,
  ): AgentTeamAcceptanceCase[] {
    if (!isImplementationWorkerOutbox(outbox) || !outbox.panelId) {
      return [];
    }
    return ensureWorkerGateAcceptance(run.workers, run.acceptance).filter(
      (item) =>
        item.status === "fail" && item.bouncedToPanelId === outbox.panelId,
    );
  }

  protected async dispatchBouncedCasesForRecheck(
    run: AgentTeamRun,
    outbox: AgentTeamWorkerOutbox,
  ): Promise<AgentTeamRun> {
    const bouncedCases = this.findBouncedCasesForWorker(run, outbox);
    if (bouncedCases.length === 0) {
      return run;
    }
    const session = this.terminalSessionManager.getSession(
      run.terminalSessionId,
    );
    if (!session) {
      return this.pauseForWorkerDispatchError(
        run,
        parseWorkerRole(outbox.role) ?? "code",
        `复验投递失败：terminal session ${run.terminalSessionId} 不存在`,
      );
    }

    let didUpdateRun = false;
    let latestRun = run;
    const dispatches = resolveRecheckDispatches(
      run,
      expandRecheckCasesForFailures(run, bouncedCases),
    );
    for (const dispatch of dispatches) {
      if (!dispatch.worker.panelId) {
        continue;
      }
      try {
        latestRun = await this.sendRecheckToWorker(
          latestRun,
          session,
          dispatch.worker,
          dispatch.cases,
          {
            attempt: 1,
            sourcePanelId: outbox.panelId ?? null,
            triggerSummary: outbox.summary,
          },
        );
        didUpdateRun = true;
      } catch (error) {
        agentTeamLogger.warn("agent-team.recheck_dispatch.failed", {
          message: "Could not dispatch recheck to worker pane",
          runId: run.runId,
          role: dispatch.worker.role,
          panelId: dispatch.worker.panelId,
          error,
        });
        latestRun = (await this.runStore.getRun(latestRun.runId)) ?? latestRun;
        latestRun = await this.markRecheckDispatchFailed(
          latestRun,
          session,
          dispatch.worker,
          dispatch.cases,
          1,
        );
        didUpdateRun = true;
      }
    }

    if (!didUpdateRun) {
      return this.pauseForRepairProtocolError(
        run,
        "已消费的 code outbox 未能建立任何复验 dispatch",
      );
    }
    return latestRun;
  }

  protected async dispatchNextSerialWorkerFromCompletion(
    run: AgentTeamRun,
    outbox: AgentTeamWorkerOutbox,
  ): Promise<AgentTeamRun | null> {
    const role = parseWorkerRole(outbox.role);
    if (!role) {
      return null;
    }
    if (
      run.phase === "executing" &&
      role === "code" &&
      outbox.status === "completed"
    ) {
      const repairKeys = run.activeWorkerDispatch?.repairKeys ?? [];
      return this.dispatchSerialWorker(run, "code_review", {
        cases: acceptanceCasesForRole(run, "code_review"),
        log: "code 完成，启动 code_review",
        triggerSummary: outbox.summary,
        acceptedRepairKeys: repairKeys,
      });
    }
    return null;
  }
}
