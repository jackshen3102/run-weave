import type {
  AgentTeamAcceptanceCase,
  AgentTeamOutboxHistoryRecord,
  AgentTeamRun,
  AgentTeamWorker,
  AgentTeamWorkerOutbox,
} from "@runweave/shared/agent-team";
import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import type { TerminalSessionRecord } from "../terminal/manager";
import {
  buildCodeFixHandoffCorrectionPrompt,
  buildReviewFindingCorrectionPrompt,
} from "./prompt-builders";
import { agentTeamLogger } from "./service-context";
import {
  logReconciledCompletion,
  logStaleCompletion,
} from "./service-completion-logging";
import { AgentTeamCompletionRecheckService } from "./service-completion-recheck";
import type {
  AgentTeamCompletionSignal,
  AgentTeamCompletionSignalSource,
} from "./service-types";
import {
  resolvePendingFindingDecision,
  reviewFindingContractErrors,
  validateCodeFixHandoff,
  type AgentTeamRepairTarget,
} from "./repair-loop";
import { captureRepairSourceFingerprint } from "./repair-source-fingerprint";
import {
  acceptanceCasesForRole,
  ensureWorkerGateAcceptance,
  expandRecheckCasesForFailures,
  isImplementationWorkerOutbox,
  resolveRecheckDispatches,
} from "./service-acceptance-policy";
import {
  completionOutboxIdentityMismatch,
  completionReviewTargetMismatch,
  completionSignalWorkerMismatch,
  findWorkerByRole,
  parseWorkerRole,
  resolveActiveWorkerDispatch,
  shouldDispatchNextSerialWorker,
  workerOutboxFreshnessMismatch,
} from "./service-workflow-policy";
import { createSyntheticCompletionEvent } from "./service-run-policy";

export abstract class AgentTeamCompletionService extends AgentTeamCompletionRecheckService {
  protected abstract resolveOutboxRound(
    run: AgentTeamRun,
    outbox: AgentTeamWorkerOutbox,
  ): {
    acceptanceResults: NonNullable<AgentTeamWorkerOutbox["acceptanceResults"]>;
    forceBounceCaseIds: string[];
    repairTargets: AgentTeamRepairTarget[];
  };

  protected abstract markRecheckDispatchFailed(
    run: AgentTeamRun,
    session: TerminalSessionRecord,
    worker: AgentTeamWorker,
    cases: AgentTeamAcceptanceCase[],
    attempt: number,
  ): Promise<AgentTeamRun>;

  protected async handleTerminalEvent(
    event: TerminalEventEnvelope,
  ): Promise<void> {
    if (event.kind !== "completion") {
      return;
    }
    await this.reconcileCompletionEvent(event, "terminal_event");
  }

  async reconcileCompletionSignal(
    signal: AgentTeamCompletionSignal,
  ): Promise<boolean> {
    const run = await this.runStore.getRunByTerminalSession(
      signal.projectId,
      signal.terminalSessionId,
    );
    if (!run || run.phase !== "executing" || run.status !== "running") {
      return false;
    }
    const session = this.terminalSessionManager.getSession(
      run.terminalSessionId,
    );
    const activeWorker = run.activeWorkerRole
      ? findWorkerByRole(run.workers, run.activeWorkerRole)
      : null;
    if (!session || !activeWorker) {
      return false;
    }
    return this.reconcileCompletionEvent(
      createSyntheticCompletionEvent(run, session, activeWorker, signal),
      signal.source,
    );
  }

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
        const latest = await this.getRun(run.runId);
        if (
          !latest ||
          latest.phase !== "executing" ||
          latest.status !== "running" ||
          !latest.activeWorkerRole
        ) {
          return false;
        }
        const activeWorker = findWorkerByRole(
          latest.workers,
          latest.activeWorkerRole,
        );
        if (!activeWorker) {
          return false;
        }
        const signalMismatch = completionSignalWorkerMismatch(
          event,
          activeWorker,
        );
        if (signalMismatch) {
          logStaleCompletion(source, latest, activeWorker, signalMismatch);
          return false;
        }
        const resolvedOutbox =
          await this.outboxResolver.resolveOutboxWithMetadata(event);
        if (!resolvedOutbox) {
          return false;
        }
        const { outbox, mtimeMs: outboxMtimeMs } = resolvedOutbox;
        const dispatch = resolveActiveWorkerDispatch(latest, activeWorker);
        if (!dispatch) {
          await this.pauseForRepairProtocolError(
            latest,
            "dispatch-id-v1 run 缺少 activeWorkerDispatch，禁止回退 legacy dispatch",
          );
          return true;
        }
        const identityMismatch = completionOutboxIdentityMismatch(
          latest,
          activeWorker,
          dispatch,
          outbox,
          source !== "terminal_event",
        );
        if (identityMismatch) {
          if (
            identityMismatch === "active_dispatch_id_missing" ||
            identityMismatch === "outbox_dispatch_id_missing"
          ) {
            await this.pauseForRepairProtocolError(
              latest,
              `dispatch-id-v1 协议错误：${identityMismatch}`,
            );
            return true;
          }
          logStaleCompletion(source, latest, activeWorker, identityMismatch);
          return false;
        }
        const freshnessMismatch = workerOutboxFreshnessMismatch(
          dispatch,
          outboxMtimeMs,
        );
        if (freshnessMismatch) {
          logStaleCompletion(source, latest, activeWorker, freshnessMismatch);
          return false;
        }
        if (
          latest.consumedWorkerDispatches?.some(
            (receipt) => receipt.dispatchId === dispatch.dispatchId,
          )
        ) {
          logStaleCompletion(
            source,
            latest,
            activeWorker,
            "outbox_dispatch_already_consumed",
          );
          return true;
        }
        let archivedOutbox;
        try {
          archivedOutbox = await this.outboxHistoryStore.archive({
            run: latest,
            dispatch,
            resolvedOutbox,
            cwd: event.payload.cwd,
          });
        } catch (error) {
          await this.pauseForRepairProtocolError(
            latest,
            `worker outbox 历史归档失败：${error instanceof Error ? error.message : String(error)}`,
          );
          return true;
        }
        const recordConsumed = (nextRun: AgentTeamRun) =>
          this.recordConsumedWorkerDispatch(nextRun, archivedOutbox.record);
        if (dispatch.protocolCorrectionAttempt) {
          const expected = dispatch.protocolCorrectionSourceFingerprint;
          if (!expected) {
            const pausedRun = await this.pauseForRepairProtocolError(
              latest,
              "协议补交缺少源码指纹，无法证明补交期间未修改源码",
            );
            await recordConsumed(pausedRun);
            return true;
          }
          try {
            const actual = await captureRepairSourceFingerprint(
              this.resolveRequiredProjectRoot(
                latest.projectId,
                event.payload.cwd ?? latest.terminal.cwd ?? "",
              ),
            );
            if (
              actual.repoRoot !== expected.repoRoot ||
              actual.sha256 !== expected.sha256
            ) {
              const pausedRun = await this.pauseForRepairProtocolError(
                latest,
                "协议补交期间源码、Git HEAD 或 index 已变化",
              );
              await recordConsumed(pausedRun);
              return true;
            }
          } catch (error) {
            const pausedRun = await this.pauseForRepairProtocolError(
              latest,
              `协议补交源码指纹复核失败：${error instanceof Error ? error.message : String(error)}`,
            );
            await recordConsumed(pausedRun);
            return true;
          }
        }
        const reviewTargetMismatch = completionReviewTargetMismatch(
          latest,
          outbox,
        );
        if (reviewTargetMismatch) {
          const pausedRun = await this.pauseForCheckpointError(
            latest,
            reviewTargetMismatch,
          );
          await recordConsumed(pausedRun);
          return true;
        }
        if (outbox.role === "behavior_verify" && latest.reviewCheckpoint) {
          const expectedCheckpointCommit =
            latest.activeWorkerDispatch?.verifiedCheckpointCommit ??
            latest.reviewCheckpoint.lastReviewedCommit;
          if (outbox.verifiedCheckpointCommit !== expectedCheckpointCommit) {
            const pausedRun = await this.pauseForCheckpointError(
              latest,
              `behavior outbox checkpoint 不匹配：expected ${expectedCheckpointCommit}，actual ${outbox.verifiedCheckpointCommit ?? "null"}`,
            );
            await recordConsumed(pausedRun);
            return true;
          }
          try {
            await this.assertVerificationSourcesUnchanged(latest);
            await this.reviewCheckpointGit.assertCheckpointHead(
              latest.reviewCheckpoint,
              latest.activeWorkerDispatch?.checkpointAllowedDirtyPaths,
              expectedCheckpointCommit,
            );
          } catch (error) {
            const pausedRun = await this.pauseForCheckpointError(
              latest,
              error instanceof Error ? error.message : String(error),
            );
            await recordConsumed(pausedRun);
            return true;
          }
        }
        const initialRound = this.resolveOutboxRound(latest, outbox);
        const reviewContractErrors = reviewFindingContractErrors(
          latest,
          outbox,
          initialRound.acceptanceResults,
        );
        if (reviewContractErrors.length > 0) {
          const correctionRun = await this.handleProtocolCorrection(
            latest,
            activeWorker,
            outboxMtimeMs,
            reviewContractErrors,
            (run) =>
              buildReviewFindingCorrectionPrompt({
                run,
                errors: reviewContractErrors,
              }),
            "code_review finding",
          );
          await recordConsumed(correctionRun);
          return true;
        }
        const pendingFindingDecision = resolvePendingFindingDecision(
          latest,
          outbox,
        );
        if (pendingFindingDecision) {
          const pausedRun = await this.pauseForFindingDecision(
            latest,
            pendingFindingDecision,
          );
          await recordConsumed(pausedRun);
          return true;
        }
        if (outbox.role === "code") {
          const handoff = validateCodeFixHandoff(latest, outbox);
          if (handoff.status === "reviewer_reproduction_required") {
            const reviewRun = await this.dispatchSerialWorker(
              latest,
              "code_review",
              {
                cases: acceptanceCasesForRole(latest, "code_review"),
                log: "code 无法复现重复 review finding，回派 reviewer 现场举证",
                triggerSummary: handoff.reason,
                reviewChallenge: {
                  repairKeys: handoff.repairKeys,
                  reason: handoff.reason,
                },
              },
            );
            await recordConsumed(reviewRun);
            return true;
          }
          if (handoff.status === "blocked") {
            const pausedRun = await this.pauseForRepairProtocolError(
              latest,
              handoff.reason,
            );
            await recordConsumed(pausedRun);
            return true;
          }
          if (handoff.status === "invalid") {
            const correctionRun = await this.handleProtocolCorrection(
              latest,
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
            await recordConsumed(correctionRun);
            return true;
          }
        }
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
          const pausedRun = await this.pauseForRepairProtocolError(
            latest,
            `${outbox.role} outbox 未包含可消费的验收结果`,
          );
          await recordConsumed(pausedRun);
          return true;
        }
        const serialRun = await this.dispatchNextSerialWorkerFromCompletion(
          latest,
          outbox,
        );
        if (serialRun) {
          await recordConsumed(serialRun);
          logReconciledCompletion(
            source,
            latest,
            activeWorker,
            outboxMtimeMs,
            initialRound.acceptanceResults.length,
          );
          return true;
        }
        let roundRun = latest;
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
              latest,
              outbox,
            );
            if (finalized.status !== "running") {
              await recordConsumed(finalized);
              return true;
            }
            roundRun = finalized;
          } else if (archivedOutbox.created) {
            const pausedRun = await this.pauseForCheckpointError(
              latest,
              "review pass 缺少 pending review target",
            );
            await recordConsumed(pausedRun);
            return true;
          }
        }
        const round = this.resolveOutboxRound(roundRun, outbox);
        if (!round.acceptanceResults.length) {
          const recheckRun = await this.dispatchBouncedCasesForRecheck(
            roundRun,
            outbox,
          );
          await recordConsumed(recheckRun);
          logReconciledCompletion(
            source,
            latest,
            activeWorker,
            outboxMtimeMs,
            0,
          );
          return true;
        }
        const appliedRun = await this.applyRound(roundRun, {
          acceptanceResults: round.acceptanceResults,
          forceBounceCaseIds: round.forceBounceCaseIds,
          repairTargets: round.repairTargets,
          completedWorkerRole: parseWorkerRole(outbox.role),
          completedWorkerSummary: outbox.summary,
        });
        await recordConsumed(appliedRun);
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

  protected async recordConsumedWorkerDispatch(
    run: AgentTeamRun,
    history: AgentTeamOutboxHistoryRecord,
  ): Promise<AgentTeamRun> {
    if (
      run.consumedWorkerDispatches?.some(
        (receipt) => receipt.dispatchId === history.dispatchId,
      )
    ) {
      return run;
    }
    return this.updateRun(run, {
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
    });
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
        latestRun = (await this.getRun(latestRun.runId)) ?? latestRun;
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
