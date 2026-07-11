import type {
  AgentTeamActiveWorkerDispatch,
  AgentTeamAcceptanceCase,
  AgentTeamRun,
  AgentTeamStatus,
  AgentTeamWorker,
  AgentTeamWorkerOutbox,
  AgentTeamWorkerRole,
} from "@runweave/shared/agent-team";
import type { TerminalSessionRecord } from "../terminal/manager";
import { createTerminalPanelSplit } from "../terminal/application/panel-split";
import { AgentTeamError } from "./errors";
import {
  buildBounceBackPrompt,
  buildWorkerStartupPrompt,
} from "./prompt-builders";
import { buildEscalationReason, foldRound, shouldEscalate } from "./loop";
import { agentTeamLogger } from "./service-context";
import { AgentTeamServiceSupport } from "./service-support";
import {
  assertTraceableBehaviorAcceptance,
  behaviorVerificationCasesForDispatch,
  ensureWorkerGateAcceptance,
  findStableFailCaseIdsNeedingBounce,
  hasRolePassed,
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
          } catch (error) {
            throw createAgentTeamPanelError(run.runId, worker.role, error);
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
      if (panelId) {
        await this.agentReadiness.ensureAgentReady(session, terminal, {
          panelId,
        });
      }
    }
    const activeWorkerRole = resolveInitialActiveWorkerRole(boundWorkers);
    const activeWorkers = setActiveWorker(boundWorkers, activeWorkerRole);
    const activeWorker = activeWorkerRole
      ? findWorkerByRole(activeWorkers, activeWorkerRole)
      : null;
    let activeWorkerDispatch: AgentTeamActiveWorkerDispatch | null = null;
    if (activeWorker?.panelId) {
      const outboxMtimeMs = await this.readWorkerOutboxMtimeMs(
        session,
        activeWorker,
      );
      const requestedAt = new Date().toISOString();
      await this.promptSender.sendPromptToPane(
        session,
        buildWorkerStartupPrompt({
          run,
          worker: activeWorker,
          acceptance: executionAcceptance,
          outboxPath: this.paths.workerOutboxRelativePath(
            run.terminalSessionId,
            activeWorker,
          ),
        }),
        { panelId: activeWorker.panelId },
      );
      activeWorkerDispatch = createActiveWorkerDispatch(
        activeWorker,
        requestedAt,
        outboxMtimeMs,
      );
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
    return this.updateRun(run, {
      phase: "executing",
      status: "running",
      terminal,
      proposal: null,
      activeWorkerRole,
      activeWorkerDispatch,
      workers: activeWorkers,
      acceptance: executionAcceptance,
      logs: [...run.logs, context.log],
    });
  }

  protected async applyRound(
    run: AgentTeamRun,
    params: {
      acceptanceResults?: AgentTeamWorkerOutbox["acceptanceResults"];
      hadDiff?: boolean;
      forceBounceCaseIds?: string[];
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
    const logs = [...runWithGates.logs];
    if (folded.hadProgress) {
      logs.push(`round ${run.loop.round} 有进展，noProgress 计数清零`);
    } else if (params.acceptanceResults?.length || params.hadDiff === false) {
      logs.push(
        `round ${run.loop.round} 无进展，noProgress=${folded.loop.noProgressCount}/${folded.loop.maxNoProgress}`,
      );
    }

    let status: AgentTeamStatus = "running";
    let loop = folded.loop;
    let workers = run.workers;
    let activeWorkerRole = run.activeWorkerRole ?? null;
    // This completion consumed the current dispatch. A follow-up bounce or
    // serial worker dispatch will install a new boundary below.
    let activeWorkerDispatch: AgentTeamActiveWorkerDispatch | null = null;
    const allAcceptancePassed =
      folded.acceptance.length > 0 &&
      folded.acceptance.every((item) => item.status === "pass");
    if (allAcceptancePassed) {
      status = "done";
      workers = run.workers.map((worker) => ({ ...worker, frozen: true }));
      activeWorkerRole = null;
      activeWorkerDispatch = null;
      logs.push(`✅ 所有验收用例通过，run 完成`);
    } else if (shouldEscalate(folded.loop)) {
      const reason = buildEscalationReason(folded.loop, folded.acceptance);
      loop = { ...folded.loop, escalated: true, lastReason: reason };
      status = "need_human";
      // Freeze all worker panes: stop injecting further rounds.
      workers = run.workers.map((worker) => ({ ...worker, frozen: true }));
      activeWorkerRole = null;
      activeWorkerDispatch = null;
      logs.push(`⏸ ${reason}`);
    }

    const nextRun = await this.updateRun(run, {
      status,
      loop,
      acceptance: folded.acceptance,
      workers,
      activeWorkerRole,
      activeWorkerDispatch,
      logs,
    });

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
    const session = this.terminalSessionManager.getSession(
      run.terminalSessionId,
    );
    if (!session) {
      return run;
    }
    try {
      const outboxMtimeMs = await this.readWorkerOutboxMtimeMs(
        session,
        codeWorker,
      );
      const requestedAt = new Date().toISOString();
      await this.promptSender.sendPromptToPane(
        session,
        buildBounceBackPrompt({ run, failedCases }),
        { panelId: codeWorker.panelId },
      );
      const bouncedAcceptance = run.acceptance.map((item) =>
        caseIds.includes(item.caseId)
          ? { ...item, bouncedToPanelId: codeWorker.panelId }
          : item,
      );
      return this.updateRun(run, {
        acceptance: bouncedAcceptance,
        activeWorkerRole: "code",
        activeWorkerDispatch: createActiveWorkerDispatch(
          codeWorker,
          requestedAt,
          outboxMtimeMs,
        ),
        workers: setActiveWorker(run.workers, "code"),
        logs: [
          ...run.logs,
          `用例 ${caseIds.join(", ")} 稳定失败，抛回 code pane ${codeWorker.panelId}`,
        ],
      });
    } catch (error) {
      agentTeamLogger.warn("agent-team.bounce.failed", {
        message: "Could not bounce failure back to code pane",
        runId: run.runId,
        error,
      });
      return run;
    }
  }
}
