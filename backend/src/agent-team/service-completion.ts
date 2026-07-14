import type {
  AgentTeamAcceptanceCase,
  AgentTeamRun,
  AgentTeamWorker,
  AgentTeamWorkerOutbox,
} from "@runweave/shared/agent-team";
import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import type { TerminalSessionRecord } from "../terminal/manager";
import {
  buildCodeFixHandoffCorrectionPrompt,
  buildReviewFindingCorrectionPrompt,
  buildWorkerRecheckPrompt,
} from "./prompt-builders";
import { agentTeamLogger } from "./service-context";
import {
  logReconciledCompletion,
  logStaleCompletion,
} from "./service-completion-logging";
import { AgentTeamRepairProtocolService } from "./service-repair-protocol";
import type {
  AgentTeamCompletionSignal,
  AgentTeamCompletionSignalSource,
} from "./service-types";
import {
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
  createActiveWorkerDispatch,
  findWorkerByRole,
  parseWorkerRole,
  resolveActiveWorkerDispatch,
  setActiveWorker,
  shouldDispatchNextSerialWorker,
  workerOutboxFreshnessMismatch,
} from "./service-workflow-policy";
import {
  createSyntheticCompletionEvent,
  resolveAgentTeamTerminal,
} from "./service-run-policy";

export abstract class AgentTeamCompletionService extends AgentTeamRepairProtocolService {
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
        const identityMismatch = completionOutboxIdentityMismatch(
          latest,
          activeWorker,
          dispatch,
          outbox,
          source !== "terminal_event",
        );
        if (identityMismatch) {
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
        try {
          await this.outboxHistoryStore.archive({
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
        if (dispatch.protocolCorrectionAttempt) {
          const expected = dispatch.protocolCorrectionSourceFingerprint;
          if (!expected) {
            await this.pauseForRepairProtocolError(
              latest,
              "协议补交缺少源码指纹，无法证明补交期间未修改源码",
            );
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
              await this.pauseForRepairProtocolError(
                latest,
                "协议补交期间源码、Git HEAD 或 index 已变化",
              );
              return true;
            }
          } catch (error) {
            await this.pauseForRepairProtocolError(
              latest,
              `协议补交源码指纹复核失败：${error instanceof Error ? error.message : String(error)}`,
            );
            return true;
          }
        }
        const reviewTargetMismatch = completionReviewTargetMismatch(
          latest,
          outbox,
        );
        if (reviewTargetMismatch) {
          await this.pauseForCheckpointError(latest, reviewTargetMismatch);
          return true;
        }
        if (outbox.role === "behavior_verify" && latest.reviewCheckpoint) {
          if (
            outbox.verifiedCheckpointCommit !==
            latest.reviewCheckpoint.lastReviewedCommit
          ) {
            await this.pauseForCheckpointError(
              latest,
              `behavior outbox checkpoint 不匹配：expected ${latest.reviewCheckpoint.lastReviewedCommit}，actual ${outbox.verifiedCheckpointCommit ?? "null"}`,
            );
            return true;
          }
          try {
            await this.assertVerificationSourcesUnchanged(latest);
            await this.reviewCheckpointGit.assertCheckpointHead(
              latest.reviewCheckpoint,
            );
          } catch (error) {
            await this.pauseForCheckpointError(
              latest,
              error instanceof Error ? error.message : String(error),
            );
            return true;
          }
        }
        const initialRound = this.resolveOutboxRound(latest, outbox);
        const reviewContractErrors = reviewFindingContractErrors(
          outbox,
          initialRound.acceptanceResults,
        );
        if (reviewContractErrors.length > 0) {
          await this.handleProtocolCorrection(
            latest,
            activeWorker,
            outboxMtimeMs,
            reviewContractErrors,
            buildReviewFindingCorrectionPrompt({
              run: latest,
              errors: reviewContractErrors,
            }),
            "code_review finding",
          );
          return true;
        }
        if (outbox.role === "code") {
          const handoff = validateCodeFixHandoff(latest, outbox);
          if (handoff.status === "blocked") {
            await this.pauseForRepairProtocolError(latest, handoff.reason);
            return true;
          }
          if (handoff.status === "invalid") {
            await this.handleProtocolCorrection(
              latest,
              activeWorker,
              outboxMtimeMs,
              handoff.errors,
              buildCodeFixHandoffCorrectionPrompt({
                run: latest,
                errors: handoff.errors,
              }),
              "code fixVerifications",
            );
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
          return false;
        }
        if (await this.dispatchNextSerialWorkerFromCompletion(latest, outbox)) {
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
          const finalized = await this.finalizeReviewCheckpoint(latest, outbox);
          if (finalized.status !== "running") {
            return true;
          }
          roundRun = finalized;
        }
        const round = this.resolveOutboxRound(roundRun, outbox);
        if (!round.acceptanceResults.length) {
          await this.dispatchBouncedCasesForRecheck(latest, outbox);
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
      return run;
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
      return run;
    }
    return latestRun;
  }

  protected async dispatchNextSerialWorkerFromCompletion(
    run: AgentTeamRun,
    outbox: AgentTeamWorkerOutbox,
  ): Promise<boolean> {
    const role = parseWorkerRole(outbox.role);
    if (!role) {
      return false;
    }
    if (
      run.phase === "executing" &&
      role === "code" &&
      outbox.status === "completed"
    ) {
      const repairKeys = run.activeWorkerDispatch?.repairKeys ?? [];
      await this.dispatchSerialWorker(run, "code_review", {
        cases: acceptanceCasesForRole(run, "code_review"),
        log: "code 完成，启动 code_review",
        triggerSummary: outbox.summary,
        acceptedRepairKeys: repairKeys,
      });
      return true;
    }
    return false;
  }

  protected async sendRecheckToWorker(
    run: AgentTeamRun,
    session: TerminalSessionRecord,
    worker: AgentTeamWorker,
    cases: AgentTeamAcceptanceCase[],
    options: {
      attempt: number;
      sourcePanelId?: string | null;
      reason?: "timeout_retry";
      triggerSummary?: string | null;
    },
  ): Promise<AgentTeamRun> {
    if (!worker.panelId) {
      return run;
    }
    const terminal = resolveAgentTeamTerminal(run.terminal);
    await this.agentReadiness.ensureAgentReady(session, terminal, {
      panelId: worker.panelId,
    });
    const outboxPath = this.paths.workerOutboxRelativePath(
      run.terminalSessionId,
      worker,
    );
    const outboxMtimeMs = await this.readWorkerOutboxMtimeMs(session, worker);
    const now = new Date().toISOString();
    const activeWorkerDispatch = createActiveWorkerDispatch(
      worker,
      now,
      outboxMtimeMs,
      run.loop.round,
      worker.role === "code_review"
        ? (run.reviewCheckpoint?.pendingReview ?? null)
        : null,
    );
    await this.promptSender.sendPromptToPane(
      session,
      buildWorkerRecheckPrompt({
        run,
        worker,
        cases,
        outboxPath,
        triggerSummary: options.triggerSummary ?? null,
      }),
      { panelId: worker.panelId },
    );

    const caseIds = new Set(cases.map((item) => item.caseId));
    const logPrefix =
      options.reason === "timeout_retry"
        ? `复验 worker 超时，已重试触发用例`
        : `code pane ${options.sourcePanelId ?? ""} 已完成，重新触发用例`;
    return this.updateRun(run, {
      activeWorkerRole: worker.role,
      activeWorkerDispatch,
      workers: setActiveWorker(run.workers, worker.role),
      acceptance: ensureWorkerGateAcceptance(run.workers, run.acceptance).map(
        (item) =>
          caseIds.has(item.caseId)
            ? {
                ...item,
                status: "pending" as const,
                consecutiveFail: 0,
                resultSummary: null,
                bouncedToPanelId: null,
                recheckRequestedAt: now,
                recheckDispatchId: activeWorkerDispatch.dispatchId ?? null,
                recheckWorkerPanelId: worker.panelId,
                recheckWorkerRole: worker.role,
                recheckOutboxMtimeMs: outboxMtimeMs,
                recheckAttempt: options.attempt,
              }
            : item,
      ),
      logs: [
        ...run.logs,
        `${logPrefix} ${Array.from(caseIds).join(", ")} 复验（${worker.role} pane ${worker.panelId}，attempt ${options.attempt}）`,
      ],
    });
  }
}
