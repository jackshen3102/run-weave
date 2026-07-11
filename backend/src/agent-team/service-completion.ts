import type {
  AgentTeamAcceptanceCase,
  AgentTeamRun,
  AgentTeamWorker,
  AgentTeamWorkerOutbox,
  AgentTeamWorkerRole,
} from "@runweave/shared/agent-team";
import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import type { TerminalSessionRecord } from "../terminal/manager";
import { buildWorkerRecheckPrompt } from "./prompt-builders";
import { AgentTeamExecutionService } from "./service-execution";
import { agentTeamLogger } from "./service-context";
import type {
  AgentTeamCompletionSignal,
  AgentTeamCompletionSignalSource,
} from "./service-types";
import {
  acceptanceCasesForRole,
  ensureWorkerGateAcceptance,
  expandRecheckCasesForFailures,
  isImplementationWorkerOutbox,
  resolveRecheckDispatches,
} from "./service-acceptance-policy";
import {
  completionOutboxIdentityMismatch,
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

export abstract class AgentTeamCompletionService extends AgentTeamExecutionService {
  protected abstract resolveOutboxRound(
    run: AgentTeamRun,
    outbox: AgentTeamWorkerOutbox,
  ): {
    acceptanceResults: NonNullable<AgentTeamWorkerOutbox["acceptanceResults"]>;
    forceBounceCaseIds: string[];
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
          this.logStaleCompletion(source, latest, activeWorker, signalMismatch);
          return false;
        }
        const resolvedOutbox =
          await this.outboxResolver.resolveOutboxWithMetadata(event);
        if (!resolvedOutbox) {
          return false;
        }
        const { outbox, mtimeMs: outboxMtimeMs } = resolvedOutbox;
        const identityMismatch = completionOutboxIdentityMismatch(
          latest,
          activeWorker,
          outbox,
          source !== "terminal_event",
        );
        if (identityMismatch) {
          this.logStaleCompletion(
            source,
            latest,
            activeWorker,
            identityMismatch,
          );
          return false;
        }
        const dispatch = resolveActiveWorkerDispatch(latest, activeWorker);
        const freshnessMismatch = workerOutboxFreshnessMismatch(
          dispatch,
          outboxMtimeMs,
        );
        if (freshnessMismatch) {
          this.logStaleCompletion(
            source,
            latest,
            activeWorker,
            freshnessMismatch,
          );
          return false;
        }
        const initialRound = this.resolveOutboxRound(latest, outbox);
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
          this.logReconciledCompletion(
            source,
            latest,
            activeWorker,
            outboxMtimeMs,
            initialRound.acceptanceResults.length,
          );
          return true;
        }
        const round = this.resolveOutboxRound(latest, outbox);
        if (!round.acceptanceResults.length) {
          await this.dispatchBouncedCasesForRecheck(latest, outbox);
          this.logReconciledCompletion(
            source,
            latest,
            activeWorker,
            outboxMtimeMs,
            0,
          );
          return true;
        }
        await this.applyRound(latest, {
          acceptanceResults: round.acceptanceResults,
          forceBounceCaseIds: round.forceBounceCaseIds,
          completedWorkerRole: parseWorkerRole(outbox.role),
          completedWorkerSummary: outbox.summary,
        });
        this.logReconciledCompletion(
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

  protected logStaleCompletion(
    source: AgentTeamCompletionSignalSource,
    run: AgentTeamRun,
    worker: AgentTeamWorker,
    reason: string,
  ): void {
    const fields = {
      message: "Agent-team completion did not match the active dispatch",
      source,
      runId: run.runId,
      role: worker.role,
      panelId: worker.panelId ?? null,
      reason,
    };
    if (source === "watchdog") {
      agentTeamLogger.debug("agent-team.completion.stale", fields);
      return;
    }
    agentTeamLogger.info("agent-team.completion.stale", fields);
  }

  protected logReconciledCompletion(
    source: AgentTeamCompletionSignalSource,
    run: AgentTeamRun,
    worker: AgentTeamWorker,
    outboxMtimeMs: number | null,
    resultCount: number,
  ): void {
    agentTeamLogger.info("agent-team.completion.reconciled", {
      message: "Agent-team completion reconciled from worker outbox",
      source,
      runId: run.runId,
      role: worker.role,
      panelId: worker.panelId ?? null,
      outboxMtimeMs,
      resultCount,
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
    if (run.phase === "executing" && role === "code") {
      await this.dispatchSerialWorker(run, "code_review", {
        cases: acceptanceCasesForRole(run, "code_review"),
        log: "code 完成，启动 code_review",
        triggerSummary: outbox.summary,
      });
      return true;
    }
    return false;
  }

  protected async dispatchSerialWorker(
    run: AgentTeamRun,
    role: AgentTeamWorkerRole,
    options: {
      cases: AgentTeamAcceptanceCase[];
      log: string;
      triggerSummary?: string | null;
    },
  ): Promise<AgentTeamRun> {
    const session = this.terminalSessionManager.getSession(
      run.terminalSessionId,
    );
    if (!session) {
      return run;
    }
    const worker = findWorkerByRole(run.workers, role);
    if (!worker?.panelId) {
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
    await this.promptSender.sendPromptToPane(
      session,
      buildWorkerRecheckPrompt({
        run,
        worker,
        cases: options.cases,
        outboxPath,
        triggerSummary: options.triggerSummary ?? null,
      }),
      { panelId: worker.panelId },
    );

    const caseIds = new Set(options.cases.map((item) => item.caseId));
    return this.updateRun(run, {
      activeWorkerRole: role,
      activeWorkerDispatch: createActiveWorkerDispatch(
        worker,
        now,
        outboxMtimeMs,
      ),
      workers: setActiveWorker(run.workers, role),
      acceptance: run.acceptance.map((item) =>
        caseIds.has(item.caseId)
          ? {
              ...item,
              status: "pending" as const,
              consecutiveFail: 0,
              bouncedToPanelId: null,
              recheckRequestedAt: now,
              recheckWorkerPanelId: worker.panelId,
              recheckWorkerRole: worker.role,
              recheckOutboxMtimeMs: outboxMtimeMs,
              recheckAttempt: 1,
            }
          : item,
      ),
      logs: [...run.logs, `${options.log}（${role} pane ${worker.panelId}）`],
    });
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
      activeWorkerDispatch: createActiveWorkerDispatch(
        worker,
        now,
        outboxMtimeMs,
      ),
      workers: setActiveWorker(run.workers, worker.role),
      acceptance: ensureWorkerGateAcceptance(run.workers, run.acceptance).map(
        (item) =>
          caseIds.has(item.caseId)
            ? {
                ...item,
                status: "pending" as const,
                consecutiveFail: 0,
                bouncedToPanelId: null,
                recheckRequestedAt: now,
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
