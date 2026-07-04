import type {
  AgentTeamAcceptanceCase,
  AgentTeamRun,
  AgentTeamStatus,
  AgentTeamTerminal,
  AgentTeamWorker,
  AgentTeamWorkerOutbox,
  AgentTeamWorkerRole,
  CreateAgentTeamRunRequest,
  ProposeAgentTeamSplitRequest,
  RecordAgentTeamRoundRequest,
  ResumeAgentTeamRunRequest,
  SubmitAgentTeamSplitGateRequest,
  TerminalEventEnvelope,
} from "@runweave/shared";
import type {
  TerminalSessionManager,
  TerminalPanelRecord,
  TerminalSessionRecord,
} from "../terminal/manager";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import type { TerminalEventService } from "../terminal/terminal-event-service";
import {
  getAgentForCommand,
  type TerminalStateService,
} from "../terminal/terminal-state-service";
import type { TmuxOutputWatcher } from "../terminal/tmux-output-watcher";
import type { TmuxService } from "../terminal/tmux-service";
import { logger } from "../logging";
import {
  createTerminalPanelSplit,
  ensureTerminalPanelWorkspace,
} from "../routes/terminal-panel-routes";
import { AgentTeamError } from "./errors";
import { AgentTeamOutboxResolver } from "./outbox-resolver";
import { AgentTeamPromptSender } from "./prompt-sender";
import { AgentTeamPaths } from "./storage/agent-team-paths";
import { AgentTeamRunStore } from "./storage/run-store";
import { createAgentTeamRunId } from "./run-id";
import {
  buildBounceBackPrompt,
  buildHumanNotePrompt,
  buildStartupPrompt,
  buildWorkerStartupPrompt,
} from "./prompt-builders";
import {
  buildEscalationReason,
  createInitialLoop,
  foldRound,
  shouldEscalate,
} from "./loop";
import { AgentTeamAgentReadinessService } from "./agent-readiness";

const agentTeamLogger = logger.child({ component: "agent-team-service" });
const DEFAULT_AGENT_TEAM_AGENT_COMMAND = "codex";
const MANUAL_FEEDBACK_COMPLETION_GRACE_MS = 200;

interface AgentTeamServiceOptions {
  terminalSessionManager: TerminalSessionManager;
  terminalEventService: TerminalEventService;
  ptyService: PtyService;
  runtimeRegistry: TerminalRuntimeRegistry;
  terminalStateService: TerminalStateService;
  tmuxService?: TmuxService;
  tmuxOutputWatcher?: TmuxOutputWatcher;
  cwd?: string;
}

let workerCounter = 0;

export class AgentTeamService {
  private readonly terminalSessionManager: TerminalSessionManager;
  private readonly terminalEventService: TerminalEventService;
  private readonly ptyService: PtyService;
  private readonly runtimeRegistry: TerminalRuntimeRegistry;
  private readonly terminalStateService: TerminalStateService;
  private readonly tmuxService?: TmuxService;
  private readonly tmuxOutputWatcher?: TmuxOutputWatcher;
  private readonly paths: AgentTeamPaths;
  private readonly runStore: AgentTeamRunStore;
  private readonly promptSender: AgentTeamPromptSender;
  private readonly agentReadiness: AgentTeamAgentReadinessService;
  private readonly outboxResolver: AgentTeamOutboxResolver;
  private readonly eventQueues = new Map<string, Promise<unknown>>();
  private readonly pendingCompletionRounds = new Map<string, number>();

  constructor(options: AgentTeamServiceOptions) {
    this.terminalSessionManager = options.terminalSessionManager;
    this.terminalEventService = options.terminalEventService;
    this.ptyService = options.ptyService;
    this.runtimeRegistry = options.runtimeRegistry;
    this.terminalStateService = options.terminalStateService;
    this.tmuxService = options.tmuxService;
    this.tmuxOutputWatcher = options.tmuxOutputWatcher;
    this.paths = new AgentTeamPaths(
      this.terminalSessionManager,
      options.cwd ?? process.cwd(),
    );
    this.runStore = new AgentTeamRunStore(
      this.terminalSessionManager,
      this.paths,
    );
    this.promptSender = new AgentTeamPromptSender({
      terminalSessionManager: this.terminalSessionManager,
      ptyService: this.ptyService,
      runtimeRegistry: this.runtimeRegistry,
      tmuxService: this.tmuxService,
      tmuxOutputWatcher: this.tmuxOutputWatcher,
    });
    this.agentReadiness = new AgentTeamAgentReadinessService({
      terminalSessionManager: this.terminalSessionManager,
      ptyService: this.ptyService,
      runtimeRegistry: this.runtimeRegistry,
      terminalStateService: this.terminalStateService,
      tmuxService: this.tmuxService,
      tmuxOutputWatcher: this.tmuxOutputWatcher,
    });
    this.outboxResolver = new AgentTeamOutboxResolver(this.paths);
  }

  initialize(): void {
    this.terminalEventService.subscribe((event) => {
      void this.handleTerminalEvent(event).catch((error) => {
        agentTeamLogger.error("agent-team.terminal_event.failed", {
          message: "Failed to handle terminal event",
          eventId: event.id,
          terminalSessionId: event.terminalSessionId,
          kind: event.kind,
          error,
        });
      });
    });
  }

  async listRuns(projectId: string): Promise<AgentTeamRun[]> {
    return this.runStore.listRuns(projectId);
  }

  async getRun(runId: string): Promise<AgentTeamRun | null> {
    return this.runStore.getRun(runId);
  }

  async getRunByTerminalSession(
    projectId: string,
    terminalSessionId: string,
  ): Promise<AgentTeamRun | null> {
    return this.runStore.getRunByTerminalSession(projectId, terminalSessionId);
  }

  // --- Phase 1: plain terminal -> flow (start run) ---

  async startRun(input: CreateAgentTeamRunRequest): Promise<AgentTeamRun> {
    const session = this.requireSession(input.terminalSessionId);
    const existing = await this.runStore.getRunByTerminalSession(
      input.projectId,
      input.terminalSessionId,
    );
    if (
      existing &&
      existing.status !== "done" &&
      existing.status !== "failed"
    ) {
      throw new AgentTeamError(
        409,
        "This terminal already has an active agent-team run",
      );
    }
    const terminal = resolveAgentTeamTerminal(input.terminal);
    this.requireAgentTeamTerminalAvailable(session, terminal);
    const task = requireRunnableTask(input.task);

    // Ensure the panel workspace so worker split is possible later.
    let mainPanelId: string | null = null;
    if (this.tmuxService) {
      try {
        const workspace = await ensureTerminalPanelWorkspace(
          this.terminalSessionManager,
          session,
          {
            ptyService: this.ptyService,
            runtimeRegistry: this.runtimeRegistry,
            tmuxService: this.tmuxService,
            tmuxOutputWatcher: this.tmuxOutputWatcher,
            terminalEventService: this.terminalEventService,
          },
        );
        mainPanelId = workspace?.activePanelId ?? null;
      } catch (error) {
        agentTeamLogger.warn("agent-team.start.panel_workspace_failed", {
          message: "Could not initialize panel workspace for run",
          terminalSessionId: session.id,
          error,
        });
      }
    }
    const now = new Date().toISOString();
    const run: AgentTeamRun = {
      runId: createAgentTeamRunId(input.terminalSessionId),
      projectId: input.projectId,
      terminalSessionId: input.terminalSessionId,
      mainPanelId,
      phase: "clarify",
      status: "clarifying",
      options: { autoApproveSplit: input.options?.autoApproveSplit ?? false },
      terminal,
      task,
      clarify: [
        {
          from: "agent",
          text: "engineering-rules 流程已启动。先说说你想做什么，我来澄清意图。",
          at: now,
        },
      ],
      proposal: null,
      workers: [],
      acceptance: [],
      loop: createInitialLoop(),
      humanNotes: [],
      logs: ["engineering-rules 流程已启动 · phase = 需求澄清"],
      createdAt: now,
      updatedAt: now,
    };
    await this.agentReadiness.ensureAgentReady(
      session,
      terminal,
      mainPanelId
        ? { panelId: mainPanelId, publishSessionState: true }
        : undefined,
    );
    await this.sendStartupPromptToMain(run, buildStartupPrompt(run));
    await this.runStore.writeRun(run);
    return run;
  }

  // --- Phase 2: clarify -> proposal (+ split gate) ---

  async proposeSplit(
    runId: string,
    input: ProposeAgentTeamSplitRequest,
  ): Promise<AgentTeamRun> {
    const run = await this.requireRun(runId);
    if (run.phase === "executing") {
      throw new AgentTeamError(409, "Run is already executing");
    }
    requireRunnableTask(run.task);
    const source = input.source ?? "user";
    const workers = normalizeWorkers(input.workers);
    const acceptance = normalizeAcceptance(input.acceptance);
    const summary =
      input.summary?.trim() ||
      (source === "agent"
        ? "主 Agent 自主判断澄清充分，建议拆以下 worker，可增删/调整后确认："
        : "需求已澄清。主 Agent 建议拆以下 worker，可增删/调整后确认：");

    // Auto-approve short circuit: skip the human gate, go straight to executing.
    if (run.options.autoApproveSplit) {
      return this.applySplit(run, workers, acceptance, {
        source,
        log:
          source === "agent"
            ? "main agent 判断澄清充分 + 自动确认开启，直接 split"
            : "自动确认拆分已开启，跳过人工门，直接 split",
      });
    }

    const nextClarify = [...run.clarify];
    if (source === "agent") {
      nextClarify.push({
        from: "agent",
        text: "我判断需求已澄清充分，主动产出 worker 拆分提案（rw propose-split）。",
        at: new Date().toISOString(),
      });
    }
    return this.updateRun(run, {
      phase: "proposal",
      status: "need_human",
      clarify: nextClarify,
      proposal: { summary, workers, acceptance, source },
      logs: [
        ...run.logs,
        source === "agent"
          ? "main agent 自主判断澄清充分，调 propose-split 产出提案（待人工确认）"
          : "main agent 澄清完成，产出拆分提案（待人工确认）",
      ],
    });
  }

  async submitSplitGate(
    runId: string,
    input: SubmitAgentTeamSplitGateRequest,
  ): Promise<AgentTeamRun> {
    const run = await this.requireRun(runId);
    if (run.phase !== "proposal" || !run.proposal) {
      throw new AgentTeamError(409, "Run has no pending split proposal");
    }
    if (input.verdict === "rejected") {
      return this.updateRun(run, {
        phase: "clarify",
        status: "clarifying",
        proposal: null,
        logs: [...run.logs, "人工驳回拆分提案，退回澄清"],
      });
    }
    const workers = input.workers
      ? normalizeWorkers(input.workers)
      : run.proposal.workers;
    const acceptance = input.acceptance
      ? normalizeAcceptance(input.acceptance)
      : run.proposal.acceptance;
    if (workers.length === 0) {
      throw new AgentTeamError(400, "At least one worker is required");
    }
    requireRunnableTask(run.task);
    return this.applySplit(run, workers, acceptance, {
      source: run.proposal.source,
      log: `人工确认拆分（${workers.length} worker），split pane`,
    });
  }

  // --- Phase 3: executing loop (record round) ---

  /**
   * Fold one round of acceptance results into the loop. Callable directly
   * (smoke/e2e) or internally from a pane completion event.
   */
  async recordRound(
    runId: string,
    input: RecordAgentTeamRoundRequest,
  ): Promise<AgentTeamRun> {
    return this.enqueue(runId, async () => {
      let latest = await this.requireRun(runId);
      if (isStaleExpectedRound(latest, input.expectedRound)) {
        return latest;
      }
      const manualFeedbackRound = isManualFeedbackRound(input);
      if (manualFeedbackRound) {
        await delay(MANUAL_FEEDBACK_COMPLETION_GRACE_MS);
        latest = await this.requireRun(runId);
        if (
          isStaleExpectedRound(latest, input.expectedRound) ||
          (this.pendingCompletionRounds.get(runId) ?? 0) > 0
        ) {
          return latest;
        }
      }
      return this.applyRound(latest, {
        acceptanceResults: manualFeedbackRound
          ? undefined
          : input.acceptanceResults,
        hadDiff: input.hadDiff,
      });
    });
  }

  // --- Phase 4: escalation -> resume ---

  async resumeRun(
    runId: string,
    input: ResumeAgentTeamRunRequest,
  ): Promise<AgentTeamRun> {
    const run = await this.requireRun(runId);
    const note = input.note?.trim();
    if (!note) {
      throw new AgentTeamError(400, "A human intervention note is required");
    }
    const now = new Date().toISOString();
    const clearedFingerprints = [...run.loop.errorFingerprints];
    const resumedAcceptance = run.acceptance.map((item) => ({
      ...item,
      consecutiveFail: 0,
    }));
    const resumedBestPassCount = resumedAcceptance.filter(
      (item) => item.status === "pass",
    ).length;
    const nextRun = await this.updateRun(run, {
      status: "running",
      workers: run.workers.map((worker) => ({ ...worker, frozen: false })),
      loop: {
        ...run.loop,
        noProgressCount: 0,
        escalated: false,
        lastReason: null,
        errorFingerprints: [],
        bestPassCount: resumedBestPassCount,
      },
      acceptance: resumedAcceptance,
      humanNotes: [
        ...run.humanNotes,
        { id: `note_${Date.now()}`, at: now, text: note, clearedFingerprints },
      ],
      logs: [...run.logs, "人工介入后恢复，loop 重新计数"],
    });
    // Inject the human note back into the main agent context.
    await this.trySendToMain(nextRun, buildHumanNotePrompt(note));
    return nextRun;
  }

  async focusPane(runId: string, panelId: string): Promise<AgentTeamRun> {
    const run = await this.requireRun(runId);
    const session = this.requireSession(run.terminalSessionId);
    const worker = run.workers.find((item) => item.panelId === panelId);
    if (!worker && panelId !== run.mainPanelId) {
      throw new AgentTeamError(404, "Pane does not belong to this run");
    }
    if (this.tmuxService) {
      const panel = this.terminalSessionManager.getPanel(panelId);
      if (panel) {
        try {
          const paneTarget = {
            ...this.tmuxService.buildTarget(session.id),
            paneId: panel.tmuxPaneId,
          };
          await this.tmuxService.selectPane(paneTarget);
          await this.terminalSessionManager.focusPanel(session.id, panelId);
          this.terminalEventService.record({
            kind: "terminal_panel_focused",
            terminalSessionId: session.id,
            projectId: session.projectId,
            payload: {
              terminalSessionId: session.id,
              panelId,
              alias: panel.alias,
              role: panel.role,
              source: "api",
              workspace: this.terminalSessionManager.getPanelWorkspace(
                session.id,
              )!,
            } as never,
          });
        } catch (error) {
          agentTeamLogger.warn("agent-team.focus.failed", {
            message: "Could not focus pane",
            runId,
            panelId,
            error,
          });
        }
      }
    }
    return run;
  }

  // --- internal helpers ---

  private async applySplit(
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
        frozen: false,
      };
      boundWorkers.push(boundWorker);
      if (panelId) {
        await this.agentReadiness.ensureAgentReady(session, terminal, {
          panelId,
        });
        await this.promptSender.sendPromptToPane(
          session,
          buildWorkerStartupPrompt({
            run,
            worker: boundWorker,
            acceptance,
            outboxPath: this.paths.workerOutboxRelativePath(
              run.terminalSessionId,
              boundWorker,
            ),
          }),
          { panelId },
        );
      }
    }
    if (this.tmuxService && boundWorkers.some((worker) => worker.panelId)) {
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
      workers: boundWorkers,
      acceptance,
      logs: [...run.logs, context.log],
    });
  }

  private async applyRound(
    run: AgentTeamRun,
    params: {
      acceptanceResults?: AgentTeamWorkerOutbox["acceptanceResults"];
      hadDiff?: boolean;
    },
  ): Promise<AgentTeamRun> {
    if (run.phase !== "executing") {
      throw new AgentTeamError(409, "Run is not executing");
    }
    if (run.status === "need_human") {
      // Frozen: do not advance the loop until the human resumes.
      return run;
    }
    const folded = foldRound(run, params);
    const logs = [...run.logs];
    if (folded.hadProgress) {
      logs.push(`round ${run.loop.round} 有进展，noProgress 计数清零`);
    } else if (
      params.acceptanceResults?.length ||
      params.hadDiff === false
    ) {
      logs.push(
        `round ${run.loop.round} 无进展，noProgress=${folded.loop.noProgressCount}/${folded.loop.maxNoProgress}`,
      );
    }

    let status: AgentTeamStatus = "running";
    let loop = folded.loop;
    let workers = run.workers;
    if (shouldEscalate(folded.loop)) {
      const reason = buildEscalationReason(folded.loop, folded.acceptance);
      loop = { ...folded.loop, escalated: true, lastReason: reason };
      status = "need_human";
      // Freeze all worker panes: stop injecting further rounds.
      workers = run.workers.map((worker) => ({ ...worker, frozen: true }));
      logs.push(`⏸ ${reason}`);
    }

    const nextRun = await this.updateRun(run, {
      status,
      loop,
      acceptance: folded.acceptance,
      workers,
      logs,
    });

    // Bounce stable failing cases back to a code pane. Retry any stable fail
    // that has not been marked as bounced yet, so a transient prompt-send miss
    // does not leave later rounds stuck above the threshold forever.
    const caseIdsNeedingBounce =
      status === "running"
        ? findStableFailCaseIdsNeedingBounce(nextRun)
        : [];
    if (caseIdsNeedingBounce.length > 0) {
      return this.bounceFailuresToCode(nextRun, caseIdsNeedingBounce);
    }
    return nextRun;
  }

  private async bounceFailuresToCode(
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

  private async handleTerminalEvent(
    event: TerminalEventEnvelope,
  ): Promise<void> {
    if (event.kind !== "completion") {
      return;
    }
    if (!event.projectId) {
      return;
    }
    const run = await this.runStore.getRunByTerminalSession(
      event.projectId,
      event.terminalSessionId,
    );
    if (!run || run.phase !== "executing" || run.status !== "running") {
      return;
    }
    const outbox = await this.outboxResolver.resolveOutbox(event);
    if (!outbox?.acceptanceResults?.length) {
      return;
    }
    this.incrementPendingCompletionRound(run.runId);
    await this.enqueue(run.runId, async () => {
      try {
        const latest = await this.getRun(run.runId);
        if (!latest || latest.phase !== "executing") {
          return;
        }
        await this.applyRound(latest, {
          acceptanceResults: outbox.acceptanceResults,
        });
      } finally {
        this.decrementPendingCompletionRound(run.runId);
      }
    });
  }

  private async enqueue<T>(
    runId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.eventQueues.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.eventQueues.set(runId, next);
    try {
      return await next;
    } finally {
      if (this.eventQueues.get(runId) === next) {
        this.eventQueues.delete(runId);
      }
    }
  }

  private incrementPendingCompletionRound(runId: string): void {
    this.pendingCompletionRounds.set(
      runId,
      (this.pendingCompletionRounds.get(runId) ?? 0) + 1,
    );
  }

  private decrementPendingCompletionRound(runId: string): void {
    const nextCount = (this.pendingCompletionRounds.get(runId) ?? 0) - 1;
    if (nextCount > 0) {
      this.pendingCompletionRounds.set(runId, nextCount);
      return;
    }
    this.pendingCompletionRounds.delete(runId);
  }

  private async trySendToMain(run: AgentTeamRun, text: string): Promise<void> {
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

  private async sendStartupPromptToMain(
    run: AgentTeamRun,
    text: string,
  ): Promise<void> {
    const session = this.terminalSessionManager.getSession(
      run.terminalSessionId,
    );
    if (!session) {
      throw new AgentTeamError(404, "Terminal session not found");
    }
    try {
      await this.promptSender.sendPromptToPane(
        session,
        text,
        run.mainPanelId ? { panelId: run.mainPanelId } : undefined,
      );
    } catch (error) {
      agentTeamLogger.warn("agent-team.startup_prompt.failed", {
        message: "Could not inject startup prompt into main pane",
        runId: run.runId,
        error,
      });
      throw new AgentTeamError(
        error instanceof AgentTeamError ? error.statusCode : 500,
        "Could not inject agent-team startup prompt into the main pane",
        error instanceof Error ? { cause: error.message } : { cause: error },
      );
    }
  }

  private async restoreMainPaneFocus(
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

  private async updateRun(
    run: AgentTeamRun,
    patch: Partial<
      Pick<
        AgentTeamRun,
        | "phase"
        | "status"
        | "options"
        | "terminal"
        | "task"
        | "clarify"
        | "proposal"
        | "workers"
        | "acceptance"
        | "loop"
        | "humanNotes"
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
    return next;
  }

  private async requireRun(runId: string): Promise<AgentTeamRun> {
    const run = await this.getRun(runId);
    if (!run) {
      throw new AgentTeamError(404, "Agent-team run not found");
    }
    return run;
  }

  private requireSession(terminalSessionId: string): TerminalSessionRecord {
    const session = this.terminalSessionManager.getSession(terminalSessionId);
    if (!session) {
      throw new AgentTeamError(404, "Terminal session not found");
    }
    return session;
  }

  private requireAgentTeamTerminalAvailable(
    session: TerminalSessionRecord,
    terminal: AgentTeamTerminal,
  ): void {
    const targetAgent = getAgentForCommand(terminal.command ?? null);
    if (!targetAgent) {
      return;
    }
    const currentState = this.terminalStateService.getCurrent(
      session.id,
      session,
    );
    if (currentState.state === "agent_running") {
      throw new AgentTeamError(
        409,
        `Agent-team terminal is already running agent "${currentState.agent ?? "unknown"}"`,
      );
    }
    if (
      currentState.state !== "shell_idle" &&
      currentState.agent &&
      currentState.agent !== targetAgent
    ) {
      throw new AgentTeamError(
        409,
        `Agent-team terminal is already using agent "${currentState.agent}"`,
      );
    }
  }

  private findReusableWorkerPanel(
    terminalSessionId: string,
    runId: string,
    alias: string,
    role: string,
  ): TerminalPanelRecord | null {
    return (
      this.terminalSessionManager
        .listPanels(terminalSessionId)
        .find(
          (panel) =>
            panel.status === "running" &&
            panel.agentTeamRunId === runId &&
            panel.alias === alias &&
            panel.role === role,
        ) ?? null
    );
  }

  private resolveWorkerPanelAlias(
    terminalSessionId: string,
    baseAlias: string,
    runId: string,
    role: AgentTeamWorkerRole,
  ): string {
    const panels = this.terminalSessionManager.listPanels(terminalSessionId);
    const panelRole = buildAgentTeamPanelRole(runId, role);
    const reusablePanel = panels.find(
      (panel) =>
        panel.status === "running" &&
        panel.agentTeamRunId === runId &&
        panel.alias === baseAlias &&
        panel.role === panelRole,
    );
    if (reusablePanel || !panels.some((panel) => panel.alias === baseAlias)) {
      return baseAlias;
    }
    let suffix = 2;
    let nextAlias = `${baseAlias}-${suffix}`;
    while (panels.some((panel) => panel.alias === nextAlias)) {
      suffix += 1;
      nextAlias = `${baseAlias}-${suffix}`;
    }
    return nextAlias;
  }
}

const VALID_WORKER_ROLES: AgentTeamWorkerRole[] = [
  "code",
  "code_review",
  "behavior_verify",
  "plan",
  "plan_review",
];

function buildAgentTeamPanelRole(
  runId: string,
  role: AgentTeamWorkerRole,
): string {
  return `agent-team:${runId}:${role}`;
}

function findStableFailCaseIdsNeedingBounce(run: AgentTeamRun): string[] {
  return run.acceptance
    .filter(
      (item) =>
        item.status === "fail" &&
        item.consecutiveFail >= run.loop.stableFailThreshold &&
        !item.bouncedToPanelId,
    )
    .map((item) => item.caseId);
}

function isStaleExpectedRound(
  run: AgentTeamRun,
  expectedRound: number | undefined,
): boolean {
  return expectedRound !== undefined && expectedRound !== run.loop.round;
}

function isManualFeedbackRound(input: RecordAgentTeamRoundRequest): boolean {
  const results = input.acceptanceResults;
  return (
    Boolean(results?.length) &&
    results!.every(
      (result) =>
        result.evidence.some(
          (evidence) =>
            evidence.type === "text" &&
            (evidence.ref === "manual: progress" ||
              evidence.ref === "manual: no-progress"),
        ),
    )
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveAgentTeamTerminal(
  terminal: AgentTeamTerminal | undefined,
): AgentTeamTerminal {
  return {
    command: terminal?.command?.trim() || DEFAULT_AGENT_TEAM_AGENT_COMMAND,
    args: terminal?.args ?? [],
    cwd: terminal?.cwd?.trim() || null,
    runtimePreference: terminal?.runtimePreference ?? "auto",
  };
}

function requireRunnableTask(task: string | undefined): string {
  const trimmed = task?.trim() ?? "";
  if (!trimmed) {
    throw new AgentTeamError(
      400,
      "Agent-team task is required before starting workers",
    );
  }
  return trimmed;
}

function normalizeWorkers(
  workers: Array<Pick<AgentTeamWorker, "role" | "intent">> | undefined,
): AgentTeamWorker[] {
  const source =
    workers && workers.length > 0
      ? workers
      : [
          { role: "code" as const, intent: "实现主 Agent 澄清出的核心改动" },
          { role: "code_review" as const, intent: "审查改动与回归覆盖" },
          {
            role: "behavior_verify" as const,
            intent: "按验收用例跑 Playwright，回传 pass/fail + 证据",
          },
        ];
  return source.map((worker) => {
    workerCounter += 1;
    const role = VALID_WORKER_ROLES.includes(worker.role as AgentTeamWorkerRole)
      ? (worker.role as AgentTeamWorkerRole)
      : "code";
    return {
      id: `w_${Date.now()}_${workerCounter}`,
      role,
      intent: worker.intent?.trim() || `${role} worker`,
      panelId: null,
      tmuxPaneId: null,
      frozen: false,
    };
  });
}

function normalizeAcceptance(
  acceptance: Array<Pick<AgentTeamAcceptanceCase, "text">> | undefined,
): AgentTeamAcceptanceCase[] {
  const source =
    acceptance && acceptance.length > 0
      ? acceptance
      : [
          { text: "核心改动按澄清意图落地，页面/行为符合预期" },
          { text: "关键回归用例通过，无明显破坏" },
        ];
  return source.map((item, index) => ({
    caseId: `case_${index + 1}`,
    text: item.text?.trim() || `验收用例 ${index + 1}`,
    status: "pending" as const,
    consecutiveFail: 0,
    evidence: [],
    bouncedToPanelId: null,
  }));
}

function createAgentTeamPanelError(
  runId: string,
  role: AgentTeamWorkerRole,
  error: unknown,
): AgentTeamError {
  const message = error instanceof Error ? error.message : String(error);
  const statusCode =
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
      ? error.statusCode
      : 409;
  return new AgentTeamError(
    statusCode,
    `Could not split worker pane for role "${role}": ${message}`,
    { runId, role },
  );
}
