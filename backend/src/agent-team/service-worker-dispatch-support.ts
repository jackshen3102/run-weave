import type {
  AgentTeamRun,
  AgentTeamTerminal,
  AgentTeamWorker,
} from "@runweave/shared/agent-team";
import type {
  TerminalPanelRecord,
  TerminalSessionRecord,
} from "../terminal/manager";
import { getAgentForCommand } from "../terminal/terminal-state-service";
import { AgentTeamError } from "./errors";
import { buildHumanGateMainPrompt } from "./prompt-builders";
import { AgentTeamServiceContext, agentTeamLogger } from "./service-context";

const WORKER_THREAD_READINESS_TIMEOUT_MS = 10_000;

export class AgentTeamWorkerDispatchSupport extends AgentTeamServiceContext {
  protected async updateRun(
    run: AgentTeamRun,
    patch: Partial<
      Pick<
        AgentTeamRun,
        | "phase"
        | "status"
        | "options"
        | "terminal"
        | "task"
        | "verification"
        | "reviewCheckpoint"
        | "activeWorkerRole"
        | "activeWorkerDispatch"
        | "workerDispatchProtocolVersion"
        | "consumedWorkerDispatches"
        | "frameworkRepair"
        | "predecessorRunId"
        | "successorRunId"
        | "clarify"
        | "proposal"
        | "workers"
        | "acceptance"
        | "acceptanceDecisions"
        | "completionOutcome"
        | "completionHistory"
        | "loop"
        | "humanNotes"
        | "agentInterventions"
        | "findingDecisions"
        | "pendingFindingDecision"
        | "cancellation"
        | "fixtureResourceCleanup"
        | "fixtureCleanupHistory"
        | "logs"
        | "mainPanelId"
      >
    >,
  ): Promise<AgentTeamRun> {
    const next: AgentTeamRun = {
      ...run,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.runStore.writeRun(next);
    await this.observeEvolutionOutcome(run, next);
    if (
      run.status !== "need_human" &&
      next.status === "need_human" &&
      next.options.notifyMainOnHumanGate !== false
    ) {
      await this.trySendToMain(next, buildHumanGateMainPrompt(next));
    }
    return next;
  }

  private async observeEvolutionOutcome(
    previous: AgentTeamRun,
    current: AgentTeamRun,
  ): Promise<void> {
    if (!this.evolutionOutcomeObserver) return;
    const codeDispatchId = this.resolveEvolutionCodeDispatchId(previous);
    if (!codeDispatchId) return;
    const source = {
      sourceDispatchId: previous.activeWorkerDispatch?.dispatchId ?? null,
      sourceRole: previous.activeWorkerRole,
    };
    try {
      if (previous.status !== current.status) {
        if (current.status === "done") {
          await this.evolutionOutcomeObserver.recordForDispatch(
            current.runId,
            codeDispatchId,
            "completed",
            { ...source, status: current.status, phase: current.phase },
            current.updatedAt,
          );
        } else if (current.status === "cancelled") {
          await this.evolutionOutcomeObserver.recordForDispatch(
            current.runId,
            codeDispatchId,
            "cancelled",
            { ...source, status: current.status, phase: current.phase },
            current.updatedAt,
          );
        }
      }
      const changedCases = current.acceptance.filter((item) => {
        const prior = previous.acceptance.find(
          (candidate) => candidate.caseId === item.caseId,
        );
        return prior?.status !== item.status && item.status !== "pending";
      });
      if (changedCases.length > 0) {
        const kind =
          previous.activeWorkerRole === "code_review"
            ? "review_gate"
            : previous.activeWorkerRole === "behavior_verify"
              ? "behavior_gate"
              : previous.activeWorkerDispatch?.repairKeys?.length
                ? "repair"
                : null;
        if (kind) {
          await this.evolutionOutcomeObserver.recordForDispatch(
            current.runId,
            codeDispatchId,
            kind,
            {
              ...source,
              results: changedCases.map((item) => ({
                caseId: item.caseId,
                status: item.status,
                summary: item.resultSummary,
              })),
            },
            current.updatedAt,
          );
        }
      }
      if (
        (current.humanNotes?.length ?? 0) > (previous.humanNotes?.length ?? 0)
      ) {
        await this.evolutionOutcomeObserver.recordForDispatch(
          current.runId,
          codeDispatchId,
          "user_correction",
          { ...source, noteCount: current.humanNotes?.length ?? 0 },
          current.updatedAt,
        );
      }
    } catch (error) {
      agentTeamLogger.warn("agent-team.evolution-outcome.fail-open", {
        message: "Evolution outcome recording failed; Agent Team continues",
        runId: current.runId,
        error,
      });
    }
  }

  private resolveEvolutionCodeDispatchId(run: AgentTeamRun): string | null {
    if (run.activeWorkerDispatch?.role === "code") {
      return run.activeWorkerDispatch.dispatchId ?? null;
    }
    return (
      [...(run.consumedWorkerDispatches ?? [])]
        .reverse()
        .find((receipt) => receipt.role === "code")?.dispatchId ?? null
    );
  }

  protected async trySendToMain(
    run: AgentTeamRun,
    text: string,
  ): Promise<void> {
    const session = this.terminalSessionManager.getSession(
      run.terminalSessionId,
    );
    if (!session) {
      return;
    }
    try {
      await this.promptSender.sendPromptToPane(
        session,
        text,
        run.mainPanelId ? { panelId: run.mainPanelId } : undefined,
      );
    } catch (error) {
      agentTeamLogger.warn("agent-team.main_prompt.failed", {
        message: "Could not inject prompt into main pane",
        runId: run.runId,
        error,
      });
    }
  }

  protected async submitWorkerDispatchPrompt(
    run: AgentTeamRun,
    session: TerminalSessionRecord,
    terminal: AgentTeamTerminal,
    worker: AgentTeamWorker,
    prompt: string,
  ): Promise<void> {
    if (!worker.panelId) {
      throw new AgentTeamError(409, `${worker.role} worker pane 不存在`);
    }
    const expectedAgent = getAgentForCommand(terminal.command ?? null);
    const panel = this.terminalSessionManager.getPanel(worker.panelId);
    let readyPanel: TerminalPanelRecord | null | undefined = panel;
    const startingThreadId =
      expectedAgent &&
      panel?.terminalState?.state === "agent_starting" &&
      panel.lastThreadProvider === expectedAgent &&
      panel.lastThreadStatus === "idle"
        ? panel.lastThreadId?.trim()
        : null;
    if (expectedAgent && startingThreadId) {
      readyPanel = await this.waitForWorkerThreadReadiness(
        worker.panelId,
        expectedAgent,
        startingThreadId,
      );
      if (!readyPanel) {
        throw new AgentTeamError(
          409,
          `${worker.role} worker 的 agent thread 未以已记录身份进入 ready，禁止向 agent_starting pane 投递`,
        );
      }
    }
    const readyPanelAgent = readyPanel
      ? (readyPanel.terminalState?.agent ??
        getAgentForCommand(readyPanel.activeCommand))
      : null;
    const reusableActiveThread =
      expectedAgent &&
      readyPanel?.status === "running" &&
      readyPanelAgent === expectedAgent &&
      (readyPanel.terminalState?.state === "agent_idle" ||
        readyPanel.terminalState?.state === "agent_running");
    if (reusableActiveThread) {
      await this.promptSender.sendPromptToPane(session, prompt, {
        panelId: worker.panelId,
      });
      return;
    }

    const resumableThreadId =
      expectedAgent &&
      panel?.status === "running" &&
      panel.terminalState?.state === "shell_idle" &&
      panel.lastThreadProvider === expectedAgent &&
      panel.lastThreadStatus === "idle"
        ? panel.lastThreadId?.trim()
        : null;
    if (resumableThreadId && expectedAgent) {
      await this.agentLaunch.submitAgentResume(session, terminal, {
        panelId: worker.panelId,
        threadId: resumableThreadId,
      });
      const resumedPanel = await this.waitForWorkerThreadReadiness(
        worker.panelId,
        expectedAgent,
        resumableThreadId,
      );
      if (!resumedPanel) {
        throw new AgentTeamError(
          409,
          `${worker.role} worker 的恢复线程未进入 ready，禁止投递 dispatch`,
        );
      }
      await this.promptSender.sendPromptToPane(session, prompt, {
        panelId: worker.panelId,
      });
      return;
    }

    const hasExistingWorkerContext = Boolean(
      run.consumedWorkerDispatches?.some(
        (receipt) => receipt.role === worker.role,
      ) ||
      panel?.threadId ||
      panel?.lastThreadId ||
      readyPanelAgent,
    );
    if (hasExistingWorkerContext) {
      throw new AgentTeamError(
        409,
        `${worker.role} worker 的既有 agent thread 当前不可复用，禁止新开 thread 丢失上下文`,
      );
    }

    await this.agentLaunch.submitAgentLaunch(session, terminal, {
      panelId: worker.panelId,
      prompt,
    });
  }

  private async waitForWorkerThreadReadiness(
    panelId: string,
    expectedAgent: NonNullable<ReturnType<typeof getAgentForCommand>>,
    expectedThreadId: string,
  ): Promise<TerminalPanelRecord | null> {
    const isReady = (candidate: TerminalPanelRecord | undefined) =>
      candidate?.status === "running" &&
      (candidate.terminalState?.state === "agent_idle" ||
        candidate.terminalState?.state === "agent_running") &&
      candidate.terminalState.agent === expectedAgent &&
      candidate.threadProvider === expectedAgent &&
      candidate.threadId?.trim() === expectedThreadId;
    const current = this.terminalSessionManager.getPanel(panelId);
    if (isReady(current)) {
      return current ?? null;
    }
    return new Promise((resolve) => {
      let unsubscribe: () => void = () => undefined;
      let settled = false;
      const finish = (candidate: TerminalPanelRecord | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        resolve(candidate);
      };
      const inspect = (candidate: TerminalPanelRecord | undefined) => {
        if (isReady(candidate)) {
          finish(candidate ?? null);
          return;
        }
        if (
          !candidate ||
          candidate.status !== "running" ||
          (candidate.terminalState?.agent &&
            candidate.terminalState.agent !== expectedAgent) ||
          candidate.terminalState?.state === "shell_idle"
        ) {
          finish(null);
        }
      };
      const timeout = setTimeout(
        () => finish(null),
        WORKER_THREAD_READINESS_TIMEOUT_MS,
      );
      unsubscribe = this.terminalSessionManager.subscribePanelMutations(
        panelId,
        inspect,
      );
      inspect(this.terminalSessionManager.getPanel(panelId));
    });
  }

  protected async restoreMainPaneFocus(
    session: TerminalSessionRecord,
    mainPanelId: string | null | undefined,
  ): Promise<void> {
    if (!mainPanelId || !this.tmuxService) {
      return;
    }
    const panel = this.terminalSessionManager.getPanel(mainPanelId);
    if (!panel) {
      return;
    }
    try {
      await this.tmuxService.selectPane({
        ...this.tmuxService.buildTarget(session.id),
        paneId: panel.tmuxPaneId,
      });
      await this.terminalSessionManager.focusPanel(session.id, mainPanelId);
      const workspace = this.terminalSessionManager.getPanelWorkspace(
        session.id,
      );
      if (workspace) {
        this.terminalEventService.record({
          kind: "terminal_panel_focused",
          terminalSessionId: session.id,
          projectId: session.projectId,
          payload: {
            terminalSessionId: session.id,
            panelId: mainPanelId,
            alias: panel.alias,
            role: panel.role,
            source: "api",
            workspace,
          } as never,
        });
      }
    } catch (error) {
      agentTeamLogger.warn("agent-team.restore_main_focus.failed", {
        message: "Could not restore main pane focus after split",
        terminalSessionId: session.id,
        panelId: mainPanelId,
        error,
      });
    }
  }
}
