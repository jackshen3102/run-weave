import type {
  AgentTeamActiveWorkerDispatch,
  AgentTeamAcceptanceCase,
  AgentTeamPendingFindingDecision,
  AgentTeamRun,
  AgentTeamStatus,
  AgentTeamWorker,
  AgentTeamWorkerOutbox,
  AgentTeamWorkerRole,
} from "@runweave/shared/agent-team";
import type { TerminalSessionRecord } from "../terminal/manager";
import { createTerminalPanelSplit } from "../terminal/application/panel-split";
import { resolveTmuxTarget } from "../terminal/runtime-launcher";
import { AgentTeamError } from "./errors";
import {
  partialPanelFromError,
  pendingDecisionFromReviewCycle,
  type CreatedWorkerPanel,
} from "./service-execution-support";
import {
  buildBounceBackPrompt,
  buildWorkerStartupPrompt,
} from "./prompt-builders";
import { buildEscalationReason, foldRound, shouldEscalate } from "./loop";
import {
  buildRepairEscalationReason,
  foldRepairGateResult,
  repairCyclesForCases,
  type AgentTeamRepairTarget,
} from "./repair-loop";
import { agentTeamLogger } from "./service-context";
import { AgentTeamServiceSupport } from "./service-support";
import {
  acceptanceCasesForRole,
  assertTraceableBehaviorAcceptance,
  behaviorVerificationCasesForDispatch,
  ensureWorkerGateAcceptance,
  findStableFailCaseIdsNeedingBounce,
  hasRolePassed,
  isReviewGateAcceptanceCase,
  isUnbouncedFailCase,
  mergeCaseIds,
} from "./service-acceptance-policy";
import {
  buildAgentTeamPanelRole,
  createActiveWorkerDispatch,
  findWorkerByRole,
  resolveInitialActiveWorkerRole,
  setActiveWorker,
} from "./service-workflow-policy";
import {
  createAgentTeamPanelError,
  resolveAgentTeamTerminal,
  requireRunnableTask,
} from "./service-run-policy";

export abstract class AgentTeamExecutionService extends AgentTeamServiceSupport {
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

  protected abstract readWorkerOutboxMtimeMs(
    session: TerminalSessionRecord,
    worker: Pick<AgentTeamWorker, "panelId" | "tmuxPaneId">,
  ): Promise<number | null>;

  protected async applySplit(
    run: AgentTeamRun,
    workers: AgentTeamWorker[],
    acceptance: AgentTeamAcceptanceCase[],
    context: { source: "user" | "agent"; log: string },
  ): Promise<AgentTeamRun> {
    const session = this.requireSession(run.terminalSessionId);
    const terminal = resolveAgentTeamTerminal(run.terminal);
    requireRunnableTask(run.task);
    if (this.tmuxService) {
      await this.terminalSessionManager.updateSessionPanelSplitEnabled(
        session.id,
        true,
      );
    }
    const executionAcceptance = ensureWorkerGateAcceptance(workers, acceptance);
    assertTraceableBehaviorAcceptance(workers, executionAcceptance);
    const boundWorkers: AgentTeamWorker[] = [];
    const createdPanels: CreatedWorkerPanel[] = [];
    let activeWorkers: AgentTeamWorker[] = [];
    let activeWorker: AgentTeamWorker | null = null;
    let activeWorkerDispatch: AgentTeamActiveWorkerDispatch | null = null;
    let persistedRun: AgentTeamRun;
    try {
      for (const worker of workers) {
        let panelId: string | null = null;
        let tmuxPaneId: string | null = null;
        const panelAlias = this.resolveWorkerPanelAlias(
          session.id,
          `${worker.role}-${boundWorkers.length + 1}`,
          run.runId,
          worker.role,
        );
        const panelRole = buildAgentTeamPanelRole(run.runId, worker.role);
        if (this.tmuxService) {
          const existingPanel = this.findReusableWorkerPanel(
            session.id,
            run.runId,
            panelAlias,
            panelRole,
          );
          if (existingPanel) {
            panelId = existingPanel.id;
            tmuxPaneId = existingPanel.tmuxPaneId;
          } else {
            try {
              const { panel } = await createTerminalPanelSplit(
                this.terminalSessionManager,
                session,
                {
                  ptyService: this.ptyService,
                  runtimeRegistry: this.runtimeRegistry,
                  tmuxService: this.tmuxService,
                  tmuxOutputWatcher: this.tmuxOutputWatcher,
                  terminalEventService: this.terminalEventService,
                },
                {
                  direction: boundWorkers.length % 2 === 0 ? "right" : "down",
                  role: panelRole,
                  alias: panelAlias,
                  agentTeamRunId: run.runId,
                  agentTeamWorkerId: worker.id,
                  cwd: terminal.cwd ?? undefined,
                  focus: false,
                },
              );
              panelId = panel.id;
              tmuxPaneId = panel.tmuxPaneId;
              createdPanels.push({ panelId, tmuxPaneId });
            } catch (error) {
              const panelError = createAgentTeamPanelError(
                run.runId,
                worker.role,
                error,
              );
              const partialPanel = partialPanelFromError(panelError);
              if (partialPanel) {
                createdPanels.push(partialPanel);
              }
              throw panelError;
            }
          }
        }
        const boundWorker: AgentTeamWorker = {
          ...worker,
          panelId,
          tmuxPaneId,
          frozen: true,
        };
        boundWorkers.push(boundWorker);
      }
      const activeWorkerRole = resolveInitialActiveWorkerRole(
        boundWorkers,
        run.options.flow ?? "code_first",
      );
      activeWorkers = setActiveWorker(boundWorkers, activeWorkerRole);
      activeWorker = activeWorkerRole
        ? findWorkerByRole(activeWorkers, activeWorkerRole)
        : null;
      if (activeWorker?.panelId) {
        const outboxMtimeMs = await this.readWorkerOutboxMtimeMs(
          session,
          activeWorker,
        );
        const requestedAt = new Date().toISOString();
        activeWorkerDispatch = createActiveWorkerDispatch(
          activeWorker,
          requestedAt,
          outboxMtimeMs,
          run.loop.round,
        );
      }
      persistedRun = await this.updateRun(run, {
        phase: "executing",
        status: "running",
        terminal,
        proposal: null,
        activeWorkerRole,
        activeWorkerDispatch,
        workerDispatchProtocolVersion: 1,
        consumedWorkerDispatches: run.consumedWorkerDispatches ?? [],
        workers: activeWorkers,
        acceptance: executionAcceptance,
        logs: [...run.logs, context.log],
      });
    } catch (error) {
      const rollbackErrors = await this.rollbackWorkerPanels(
        session,
        createdPanels,
      );
      await this.restoreMainPaneFocus(session, run.mainPanelId);
      if (rollbackErrors.length > 0) {
        throw new AgentTeamError(
          409,
          `Worker pane 创建或 Run 持久化失败，且新建 pane 回滚不完整：${rollbackErrors.join("; ")}`,
        );
      }
      throw error;
    }
    if (activeWorker?.panelId && activeWorkerDispatch) {
      const startupPrompt = buildWorkerStartupPrompt({
        run: persistedRun,
        worker: activeWorker,
        acceptance: executionAcceptance,
        outboxPath: this.paths.workerOutboxRelativePath(
          run.terminalSessionId,
          activeWorker,
        ),
      });
      try {
        await this.agentLaunch.submitAgentLaunch(session, terminal, {
          panelId: activeWorker.panelId,
          prompt: startupPrompt,
        });
      } catch (error) {
        return this.pauseForWorkerDispatchError(
          persistedRun,
          activeWorker.role,
          `readiness 失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (this.tmuxService && activeWorkers.some((worker) => worker.panelId)) {
      try {
        await this.tmuxService.applyMainVerticalLayout(
          this.tmuxService.buildTarget(session.id),
          50,
        );
      } catch (error) {
        agentTeamLogger.warn("agent-team.apply_layout.failed", {
          message: "Could not normalize pane layout after split",
          terminalSessionId: session.id,
          error,
        });
      }
    }
    await this.restoreMainPaneFocus(session, run.mainPanelId);
    return persistedRun;
  }

  protected async rollbackWorkerPanels(
    session: TerminalSessionRecord,
    panels: CreatedWorkerPanel[],
  ): Promise<string[]> {
    const errors: string[] = [];
    for (const panel of [...panels].reverse()) {
      if (this.tmuxService && !panel.paneRemoved) {
        await this.tmuxService
          .killPane({
            ...resolveTmuxTarget(session, this.tmuxService),
            paneId: panel.tmuxPaneId,
          })
          .catch((error: unknown) => {
            errors.push(
              `kill ${panel.tmuxPaneId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
      await this.tmuxOutputWatcher
        ?.unwatchPane(session.id, panel.tmuxPaneId)
        .catch((error: unknown) => {
          errors.push(
            `unwatch ${panel.tmuxPaneId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      await this.terminalSessionManager
        .markPanelExited(panel.panelId)
        .catch((error: unknown) => {
          errors.push(
            `mark exited ${panel.panelId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      await this.terminalSessionManager
        .removePanelFromWorkspace(session.id, panel.panelId)
        .catch((error: unknown) => {
          errors.push(
            `remove ${panel.panelId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
    return errors;
  }

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
    const folded = foldRound(runWithGates, params);
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
                status: "pass" as const,
                lastRunStatus: "pass" as const,
                resultSummary: "无代码改动，Code Review 门禁无审查对象",
              }
            : item,
        );
      }
    }
    const allAcceptancePassed =
      foldedAcceptance.length > 0 &&
      foldedAcceptance.every((item) => item.status === "pass");
    const blockedBehaviorCases =
      params.completedWorkerRole === "behavior_verify" &&
      !params.acceptanceResults?.some((result) => result.status === "fail")
        ? foldedAcceptance.filter(
            (item) =>
              item.status === "pending" && item.lastRunStatus === "skipped",
          )
        : [];
    const needsFinalReview = Boolean(
      allAcceptancePassed &&
      run.reviewCheckpoint &&
      // A zero-diff run (no checkpoint ever produced, e.g. verify_first with
      // all cases green on the first pass) has nothing to review.
      run.reviewCheckpoint.checkpoints.length > 0 &&
      run.reviewCheckpoint.finalReviewedCommit !==
        run.reviewCheckpoint.lastReviewedCommit,
    );
    if (allAcceptancePassed && !needsFinalReview) {
      status = "done";
      workers = run.workers.map((worker) => ({ ...worker, frozen: true }));
      activeWorkerRole = null;
      activeWorkerDispatch = null;
      logs.push(`✅ 所有验收用例通过，run 完成`);
    } else if (blockedBehaviorCases.length > 0) {
      const reason = `behavior_verify 环境阻塞，必跑用例未完成：${blockedBehaviorCases.map((item) => item.caseId).join(", ")}`;
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
    } else if (shouldEscalate(repairFolded.loop)) {
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

    const nextRun = await this.updateRun(run, {
      status,
      loop,
      acceptance: foldedAcceptance,
      workers,
      activeWorkerRole,
      activeWorkerDispatch,
      pendingFindingDecision,
      workerDispatchProtocolVersion: 1,
      consumedWorkerDispatches: run.consumedWorkerDispatches ?? [],
      logs,
    });

    if (status === "running" && needsFinalReview) {
      return this.dispatchSerialWorker(nextRun, "code_review", {
        cases: acceptanceCasesForRole(nextRun, "code_review"),
        log: "behavior_verify 全部通过，启动最终全量 code_review",
        triggerSummary: params.completedWorkerSummary ?? null,
        reviewScope: "final",
      });
    }

    // Bounce stable failing cases back to a code pane. Retry any stable fail
    // that has not been marked as bounced yet, so a transient prompt-send miss
    // does not leave later rounds stuck above the threshold forever.
    const caseIdsNeedingBounce =
      status === "running"
        ? mergeCaseIds(
            findStableFailCaseIdsNeedingBounce(nextRun),
            params.forceBounceCaseIds ?? [],
          ).filter((caseId) => isUnbouncedFailCase(nextRun, caseId))
        : [];
    if (caseIdsNeedingBounce.length > 0) {
      return this.bounceFailuresToCode(nextRun, caseIdsNeedingBounce);
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
    return nextRun;
  }

  protected async bounceFailuresToCode(
    run: AgentTeamRun,
    caseIds: string[],
  ): Promise<AgentTeamRun> {
    const codeWorker =
      run.workers.find((worker) => worker.role === "code" && worker.panelId) ??
      run.workers.find((worker) => worker.panelId);
    if (!codeWorker?.panelId) {
      return run;
    }
    const failedCases = run.acceptance.filter((item) =>
      caseIds.includes(item.caseId),
    );
    const repairCycles = repairCyclesForCases(run.loop, caseIds);
    const missingReproductionCaseIds = new Set(
      repairCycles
        .filter(
          (cycle) => !(cycle.sourceReproduction ?? cycle.finding?.reproduction),
        )
        .flatMap((cycle) => cycle.caseIds),
    );
    const reproductionCases = acceptanceCasesForRole(
      run,
      "behavior_verify",
    ).filter((item) => missingReproductionCaseIds.has(item.caseId));
    if (reproductionCases.length > 0) {
      return this.dispatchSerialWorker(run, "behavior_verify", {
        cases: reproductionCases,
        log: "code 修复前缺少可执行复现场景，先回派 behavior_verify",
        triggerSummary:
          "必须从真实产品入口提交 scenarioId、validationSessionId、steps、expected、actual 和 evidence；完整 reproduction 通过 backend 校验前不得回派 code。",
      });
    }
    const session = this.terminalSessionManager.getSession(
      run.terminalSessionId,
    );
    if (!session) {
      return run;
    }
    let persistedRun: AgentTeamRun | null = null;
    try {
      const outboxMtimeMs = await this.readWorkerOutboxMtimeMs(
        session,
        codeWorker,
      );
      const requestedAt = new Date().toISOString();
      const activeWorkerDispatch = createActiveWorkerDispatch(
        codeWorker,
        requestedAt,
        outboxMtimeMs,
        run.loop.round,
        null,
        { repairKeys: repairCycles.map((cycle) => cycle.repairKey) },
      );
      const bouncePrompt = buildBounceBackPrompt({
        run: {
          ...run,
          activeWorkerRole: "code",
          activeWorkerDispatch,
        },
        failedCases,
        repairCycles,
      });
      const bouncedAcceptance = run.acceptance.map((item) =>
        caseIds.includes(item.caseId)
          ? { ...item, bouncedToPanelId: codeWorker.panelId }
          : item,
      );
      persistedRun = await this.updateRun(run, {
        acceptance: bouncedAcceptance,
        activeWorkerRole: "code",
        activeWorkerDispatch,
        workerDispatchProtocolVersion: 1,
        consumedWorkerDispatches: run.consumedWorkerDispatches ?? [],
        workers: setActiveWorker(run.workers, "code"),
        logs: [
          ...run.logs,
          `用例 ${caseIds.join(", ")} 稳定失败，抛回 code pane ${codeWorker.panelId}`,
        ],
      });
      await this.submitWorkerDispatchPrompt(
        persistedRun,
        session,
        resolveAgentTeamTerminal(run.terminal),
        codeWorker,
        bouncePrompt,
      );
      return persistedRun;
    } catch (error) {
      agentTeamLogger.warn("agent-team.bounce.failed", {
        message: "Could not bounce failure back to code pane",
        runId: run.runId,
        error,
      });
      if (persistedRun) {
        return this.pauseForWorkerDispatchError(
          persistedRun,
          "code",
          `bounce prompt 投递失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return run;
    }
  }
}
