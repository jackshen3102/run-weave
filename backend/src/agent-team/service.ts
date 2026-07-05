import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  AgentTeamAcceptanceCase,
  AgentTeamExportHistoryMode,
  AgentTeamExportOutbox,
  AgentTeamExportPanel,
  AgentTeamExportResponse,
  AgentTeamFindingStatus,
  AgentTeamRun,
  AgentTeamStatus,
  AgentTeamTerminal,
  AgentTeamWorker,
  AgentTeamWorkerOutbox,
  AgentTeamWorkerRole,
  CompleteAgentTeamRunRequest,
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
import {
  AgentTeamOutboxResolver,
  normalizeAgentTeamWorkerOutbox,
} from "./outbox-resolver";
import { AgentTeamPromptSender } from "./prompt-sender";
import { AgentTeamPaths } from "./storage/agent-team-paths";
import { AgentTeamRunStore } from "./storage/run-store";
import { createAgentTeamRunId } from "./run-id";
import {
  buildBounceBackPrompt,
  buildHumanNotePrompt,
  buildPlanFixPrompt,
  buildWorkerRecheckPrompt,
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
const execFileAsync = promisify(execFile);
const DEFAULT_AGENT_TEAM_AGENT_COMMAND = "codex";
const MANUAL_FEEDBACK_COMPLETION_GRACE_MS = 200;
const RECHECK_WATCHDOG_INTERVAL_MS = 10_000;
const RECHECK_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_RECHECK_ATTEMPTS = 2;
const DEFAULT_EXPORT_TAIL_LINES = 1_000;
const MAX_EXPORT_TAIL_LINES = 5_000;

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

export interface ExportAgentTeamRunOptions {
  history?: AgentTeamExportHistoryMode;
  tailLines?: number;
  includeSessionOther?: boolean;
  includeOutboxes?: boolean;
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
  private recheckWatchdogTimer: ReturnType<typeof setInterval> | null = null;

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
    this.startRecheckWatchdog();
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

  async exportRun(
    runId: string,
    options: ExportAgentTeamRunOptions = {},
  ): Promise<AgentTeamExportResponse> {
    const run = await this.requireRun(runId);
    const session = this.requireSession(run.terminalSessionId);
    const panels = this.terminalSessionManager.listPanels(run.terminalSessionId);
    const warnings: string[] = [];
    const historyMode = options.history ?? "tail";
    const tailLines = clampExportTailLines(options.tailLines);
    const includeSessionOther = options.includeSessionOther ?? true;
    const includeOutboxes = options.includeOutboxes ?? true;
    if (historyMode === "full") {
      warnings.push(
        `history=full is capped at ${MAX_EXPORT_TAIL_LINES} lines per pane by tmux capture-pane`,
      );
    }
    const runBoundPanelIds = new Set<string>();
    if (run.mainPanelId) {
      runBoundPanelIds.add(run.mainPanelId);
    }
    for (const worker of run.workers) {
      if (worker.panelId) {
        runBoundPanelIds.add(worker.panelId);
      }
    }
    for (const panel of panels) {
      if (panel.agentTeamRunId === run.runId) {
        runBoundPanelIds.add(panel.id);
      }
      if (panel.role?.startsWith(`agent-team:${run.runId}:`)) {
        runBoundPanelIds.add(panel.id);
      }
    }

    const runBound: AgentTeamExportPanel[] = [];
    const sessionOther: AgentTeamExportPanel[] = [];
    for (const panel of panels) {
      const exportPanel = await this.buildExportPanel({
        run,
        session,
        panel,
        source: runBoundPanelIds.has(panel.id) ? "run-bound" : "session-other",
        historyMode,
        tailLines,
      });
      if (runBoundPanelIds.has(panel.id)) {
        runBound.push(exportPanel);
      } else if (includeSessionOther) {
        sessionOther.push(exportPanel);
      }
    }

    for (const panelId of runBoundPanelIds) {
      if (panels.some((panel) => panel.id === panelId)) {
        continue;
      }
      warnings.push(`Run-bound panel ${panelId} is not present in session workspace`);
      runBound.push({
        panelId,
        tmuxPaneId: null,
        alias: null,
        role: null,
        workerRole: panelId === run.mainPanelId ? "main" : "unknown",
        workerId: null,
        source: panelId === run.mainPanelId ? "main" : "worker",
        history:
          historyMode === "none"
            ? undefined
            : {
                mode: "unavailable",
                tailLines: null,
                scrollback: null,
                error: "Panel is not present in session workspace",
              },
      });
    }

    const outboxes = includeOutboxes
      ? await this.collectExportOutboxes(run, session, runBound, warnings)
      : [];

    return {
      run,
      generatedAt: new Date().toISOString(),
      projectRoot: this.resolveProjectRoot(run.projectId, session.cwd),
      panels: { runBound, sessionOther },
      outboxes,
      acceptanceSummary: buildExportAcceptanceSummary(run, outboxes),
      warnings,
    };
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
    const planFile = input.planFile?.trim() ?? null;

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
    const scopeSnapshot = await this.captureScopeSnapshot(session.cwd);
    const run: AgentTeamRun = {
      runId: createAgentTeamRunId(input.terminalSessionId),
      projectId: input.projectId,
      terminalSessionId: input.terminalSessionId,
      mainPanelId,
      phase: "intake",
      status: "running",
      options: { autoApproveSplit: input.options?.autoApproveSplit ?? false },
      terminal,
      task,
      planFile,
      activeWorkerRole: null,
      clarify: [],
      proposal: null,
      workers: [],
      acceptance: [],
      loop: createInitialLoop(),
      humanNotes: [],
      scopeSnapshot,
      logs: [
        planFile
          ? `Agent Team 任务已提交，进入计划审查：${planFile}`
          : "Agent Team 任务已提交，生成 worker 拆分提案",
      ],
      createdAt: now,
      updatedAt: now,
    };
    if (planFile) {
      return this.startPlanReview(run);
    }
    const workers = normalizeWorkers(undefined);
    const acceptance = normalizeAcceptance(undefined);
    const proposal = {
      summary: "任务已提交。建议拆以下 worker，可增删/调整后确认：",
      workers,
      acceptance,
      source: "agent" as const,
    };
    if (run.options.autoApproveSplit) {
      return this.applySplit(run, workers, acceptance, {
        source: "agent",
        log: "自动确认拆分已开启，跳过人工门，直接 split",
      });
    }
    await this.runStore.writeRun({
      ...run,
      phase: "proposal",
      status: "need_human",
      proposal,
      updatedAt: new Date().toISOString(),
    });
    return (await this.requireRun(run.runId));
  }

  // --- Phase 2: intake/plan review -> proposal (+ split gate) ---

  async proposeSplit(
    runId: string,
    input: ProposeAgentTeamSplitRequest,
  ): Promise<AgentTeamRun> {
    const run = await this.requireRun(runId);
    if (run.phase === "executing") {
      throw new AgentTeamError(409, "Run is already executing");
    }
    if (run.phase === "plan_review") {
      throw new AgentTeamError(409, "Run is still reviewing its plan file");
    }
    requireRunnableTask(run.task);
    const source = input.source ?? "user";
    const workers = normalizeWorkers(input.workers);
    const acceptance = normalizeAcceptance(input.acceptance);
    const summary =
      input.summary?.trim() ||
      (source === "agent"
        ? "主 Agent 建议拆以下 worker，可增删/调整后确认："
        : "任务已提交。建议拆以下 worker，可增删/调整后确认：");

    // Auto-approve short circuit: skip the human gate, go straight to executing.
    if (run.options.autoApproveSplit) {
      return this.applySplit(run, workers, acceptance, {
        source,
        log:
          source === "agent"
            ? "main agent 产出提案 + 自动确认开启，直接 split"
            : "自动确认拆分已开启，跳过人工门，直接 split",
      });
    }

    return this.updateRun(run, {
      phase: "proposal",
      status: "need_human",
      proposal: { summary, workers, acceptance, source },
      logs: [
        ...run.logs,
        source === "agent"
          ? "main agent 调 propose-split 产出提案（待人工确认）"
          : "main agent 产出拆分提案（待人工确认）",
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
        phase: "intake",
        status: "running",
        proposal: null,
        logs: [...run.logs, "人工驳回拆分提案，退回任务接收态"],
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
    const activeWorkerRole =
      run.activeWorkerRole ?? resolveInitialActiveWorkerRole(run.workers);
    const nextRun = await this.updateRun(run, {
      status: "running",
      activeWorkerRole,
      workers: setActiveWorker(run.workers, activeWorkerRole),
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

  async completeRun(
    runId: string,
    input: CompleteAgentTeamRunRequest,
  ): Promise<AgentTeamRun> {
    const run = await this.requireRun(runId);
    if (run.phase !== "executing") {
      throw new AgentTeamError(409, "Run is not executing");
    }
    if (run.status === "done") {
      return run;
    }
    if (run.status === "failed") {
      throw new AgentTeamError(409, "Run has already failed");
    }
    const note = input.note?.trim();
    const now = new Date().toISOString();
    return this.updateRun(run, {
      status: "done",
      workers: run.workers.map((worker) => ({ ...worker, frozen: true })),
      activeWorkerRole: null,
      loop: {
        ...run.loop,
        escalated: false,
        lastReason: null,
      },
      humanNotes: note
        ? [
            ...run.humanNotes,
            {
              id: `note_${Date.now()}`,
              at: now,
              text: note,
              clearedFingerprints: [...run.loop.errorFingerprints],
            },
          ]
        : run.humanNotes,
      logs: [
        ...run.logs,
        note
          ? `✅ 人工确认完成：${note}`
          : "✅ 人工确认完成，loop 已结束",
      ],
    });
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

  private async buildExportPanel(params: {
    run: AgentTeamRun;
    session: TerminalSessionRecord;
    panel: TerminalPanelRecord;
    source: "run-bound" | "session-other";
    historyMode: AgentTeamExportHistoryMode;
    tailLines: number;
  }): Promise<AgentTeamExportPanel> {
    const { run, session, panel, source, historyMode, tailLines } = params;
    const worker = run.workers.find((item) => item.panelId === panel.id) ?? null;
    const workerRole =
      panel.id === run.mainPanelId
        ? "main"
        : worker?.role ?? parseWorkerRoleFromPanelRole(run.runId, panel.role);
    const exportPanel: AgentTeamExportPanel = {
      panelId: panel.id,
      tmuxPaneId: panel.tmuxPaneId ?? null,
      alias: panel.alias,
      role: panel.role,
      workerRole: workerRole ?? "unknown",
      workerId: worker?.id ?? panel.agentTeamWorkerId ?? null,
      source:
        panel.id === run.mainPanelId
          ? "main"
          : source === "run-bound"
            ? "worker"
            : "session-other",
    };
    if (historyMode === "none") {
      return exportPanel;
    }
    if (!this.tmuxService) {
      return {
        ...exportPanel,
        history: {
          mode: "unavailable",
          tailLines: null,
          scrollback: null,
          error: "tmux service is unavailable",
        },
      };
    }
    try {
      const capture = await this.tmuxService.capturePane(
        {
          ...this.tmuxService.buildTarget(session.id),
          paneId: panel.tmuxPaneId,
        },
        historyMode === "full" ? MAX_EXPORT_TAIL_LINES : tailLines,
      );
      return {
        ...exportPanel,
        history: {
          mode: historyMode === "full" ? "full" : "tail",
          tailLines: historyMode === "full" ? null : tailLines,
          scrollback: capture.data,
        },
      };
    } catch (error) {
      return {
        ...exportPanel,
        history: {
          mode: "unavailable",
          tailLines: null,
          scrollback: null,
          error: formatErrorMessage(error),
        },
      };
    }
  }

  private async collectExportOutboxes(
    run: AgentTeamRun,
    session: TerminalSessionRecord,
    panels: AgentTeamExportPanel[],
    warnings: string[],
  ): Promise<AgentTeamExportOutbox[]> {
    const candidates: AgentTeamExportOutbox[] = [];
    const addCandidate = (candidate: Omit<AgentTeamExportOutbox, "exists" | "outbox">) => {
      if (candidates.some((item) => item.path === candidate.path)) {
        return;
      }
      candidates.push({ ...candidate, exists: false, outbox: null });
    };
    for (const panel of panels) {
      if (panel.panelId) {
        addCandidate({
          path: this.paths.workerOutboxPath(
            run.projectId,
            run.terminalSessionId,
            { panelId: panel.panelId },
            session.cwd,
          ),
          scope: "panel",
          panelId: panel.panelId,
          tmuxPaneId: panel.tmuxPaneId,
        });
      }
      if (panel.tmuxPaneId) {
        addCandidate({
          path: this.paths.workerOutboxPath(
            run.projectId,
            run.terminalSessionId,
            { tmuxPaneId: panel.tmuxPaneId },
            session.cwd,
          ),
          scope: "tmux-pane",
          panelId: panel.panelId,
          tmuxPaneId: panel.tmuxPaneId,
        });
      }
    }
    addCandidate({
      path: this.paths.defaultOutboxPath(
        run.projectId,
        run.terminalSessionId,
        session.cwd,
      ),
      scope: "legacy-session",
      panelId: null,
      tmuxPaneId: null,
    });

    return Promise.all(
      candidates.map(async (candidate) => {
        try {
          const raw = await readFile(candidate.path, "utf8");
          const fileStat = await stat(candidate.path);
          const outbox = normalizeAgentTeamWorkerOutbox(JSON.parse(raw), {
            terminalSessionId: run.terminalSessionId,
            projectId: run.projectId,
            panelId: candidate.panelId,
            tmuxPaneId: candidate.tmuxPaneId,
            finishedAt: fileStat.mtime.toISOString(),
          });
          if (!outbox) {
            const message = `Outbox ${candidate.path} has an invalid schema`;
            warnings.push(message);
            return {
              ...candidate,
              exists: true,
              outbox: null,
              error: message,
            };
          }
          return {
            ...candidate,
            exists: true,
            outbox,
          };
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error
              ? String((error as { code?: unknown }).code)
              : "";
          if (code !== "ENOENT") {
            warnings.push(
              `Could not read outbox ${candidate.path}: ${formatErrorMessage(error)}`,
            );
            return {
              ...candidate,
              error: formatErrorMessage(error),
            };
          }
          return candidate;
        }
      }),
    );
  }

  private async captureScopeSnapshot(
    cwd: string,
  ): Promise<AgentTeamRun["scopeSnapshot"]> {
    const capturedAt = new Date().toISOString();
    try {
      const { stdout } = await execFileAsync("git", ["status", "--short"], {
        cwd,
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      });
      return {
        capturedAt,
        gitStatusShort: stdout
          .split("\n")
          .map((line) => line.trimEnd())
          .filter(Boolean),
      };
    } catch (error) {
      return {
        capturedAt,
        gitStatusShort: [],
        error: formatErrorMessage(error),
      };
    }
  }

  private resolveProjectRoot(projectId: string, cwd: string): string | null {
    return this.terminalSessionManager.getProject(projectId)?.path ?? cwd ?? null;
  }

  // --- internal helpers ---

  private async startPlanReview(run: AgentTeamRun): Promise<AgentTeamRun> {
    const session = this.requireSession(run.terminalSessionId);
    const terminal = resolveAgentTeamTerminal(run.terminal);
    const workers = normalizeWorkers([
      {
        role: "plan" as const,
        intent: `根据 plan_review 审查意见修改计划文件 ${run.planFile ?? ""}`,
      },
      {
        role: "plan_review" as const,
        intent: `审查计划文件 ${run.planFile ?? ""} 是否可执行并具备验收闭环`,
      },
    ]);
    const acceptance = normalizePlanReviewAcceptance(run.planFile ?? "");
    if (this.tmuxService) {
      await this.terminalSessionManager.updateSessionPanelSplitEnabled(
        session.id,
        true,
      );
    }

    const boundWorkers: AgentTeamWorker[] = [];
    const activeWorkerRole: AgentTeamWorkerRole = "plan_review";
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
      const boundWorker: AgentTeamWorker = {
        ...worker,
        panelId,
        tmuxPaneId,
        frozen: worker.role !== activeWorkerRole,
      };
      boundWorkers.push(boundWorker);
      if (panelId) {
        await this.agentReadiness.ensureAgentReady(session, terminal, {
          panelId,
        });
        if (boundWorker.role === activeWorkerRole) {
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
    }
    if (this.tmuxService && boundWorkers.some((worker) => worker.panelId)) {
      try {
        await this.tmuxService.applyMainVerticalLayout(
          this.tmuxService.buildTarget(session.id),
          50,
        );
      } catch (error) {
        agentTeamLogger.warn("agent-team.apply_plan_layout.failed", {
          message: "Could not normalize pane layout after plan review split",
          terminalSessionId: session.id,
          error,
        });
      }
    }
    await this.restoreMainPaneFocus(session, run.mainPanelId);
    return this.updateRun(run, {
      phase: "plan_review",
      status: "running",
      terminal,
      activeWorkerRole,
      workers: boundWorkers,
      acceptance,
      logs: [
        ...run.logs,
        `启动计划审查 worker：${activeWorkerRole}`,
      ],
    });
  }

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
    const executionAcceptance = ensureWorkerGateAcceptance(
      workers,
      acceptance,
    );
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
    if (activeWorker?.panelId) {
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
      workers: activeWorkers,
      acceptance: executionAcceptance,
      logs: [...run.logs, context.log],
    });
  }

  private async applyRound(
    run: AgentTeamRun,
    params: {
      acceptanceResults?: AgentTeamWorkerOutbox["acceptanceResults"];
      hadDiff?: boolean;
      forceBounceCaseIds?: string[];
      completedWorkerRole?: AgentTeamWorkerRole | null;
    },
  ): Promise<AgentTeamRun> {
    if (run.phase !== "executing" && run.phase !== "plan_review") {
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
    let activeWorkerRole = run.activeWorkerRole ?? null;
    const allAcceptancePassed =
      folded.acceptance.length > 0 &&
      folded.acceptance.every((item) => item.status === "pass");
    if (allAcceptancePassed && run.phase === "plan_review") {
      const proposalWorkers = normalizeWorkers(undefined);
      const proposalAcceptance = normalizeAcceptance(undefined);
      status = "need_human";
      workers = run.workers.map((worker) => ({ ...worker, frozen: true }));
      activeWorkerRole = null;
      loop = createInitialLoop();
      logs.push("✅ 计划审查通过，进入 worker 拆分提案");
      const nextRun = await this.updateRun(run, {
        phase: "proposal",
        status,
        loop,
        acceptance: folded.acceptance,
        workers,
        activeWorkerRole,
        proposal: {
          summary: `计划文件 ${run.planFile ?? ""} 已通过审查。建议拆以下执行 worker，可增删/调整后确认：`,
          workers: proposalWorkers,
          acceptance: proposalAcceptance,
          source: "agent",
        },
        logs,
      });
      return nextRun;
    }
    if (allAcceptancePassed) {
      status = "done";
      workers = run.workers.map((worker) => ({ ...worker, frozen: true }));
      activeWorkerRole = null;
      logs.push(`✅ 所有验收用例通过，run 完成`);
    } else if (shouldEscalate(folded.loop)) {
      const reason =
        run.phase === "plan_review"
          ? buildPlanReviewEscalationReason(folded.loop.noProgressCount)
          : buildEscalationReason(folded.loop, folded.acceptance);
      loop = { ...folded.loop, escalated: true, lastReason: reason };
      status = "need_human";
      // Freeze all worker panes: stop injecting further rounds.
      workers = run.workers.map((worker) => ({ ...worker, frozen: true }));
      activeWorkerRole = null;
      logs.push(`⏸ ${reason}`);
    }

    const nextRun = await this.updateRun(run, {
      status,
      loop,
      acceptance: folded.acceptance,
      workers,
      activeWorkerRole,
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
      return nextRun.phase === "plan_review"
        ? this.bounceFailuresToPlan(nextRun, caseIdsNeedingBounce)
        : this.bounceFailuresToCode(nextRun, caseIdsNeedingBounce);
    }
    if (
      status === "running" &&
      nextRun.phase === "executing" &&
      params.completedWorkerRole === "code_review" &&
      hasRolePassed(nextRun, "code_review")
    ) {
      return this.dispatchSerialWorker(nextRun, "behavior_verify", {
        cases: acceptanceCasesForRole(nextRun, "behavior_verify"),
        log: "code_review 通过，启动 behavior_verify",
      });
    }
    return nextRun;
  }

  private async bounceFailuresToPlan(
    run: AgentTeamRun,
    caseIds: string[],
  ): Promise<AgentTeamRun> {
    const planWorker = run.workers.find(
      (worker) => worker.role === "plan" && worker.panelId,
    );
    if (!planWorker?.panelId) {
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
        buildPlanFixPrompt({ run, failedCases }),
        { panelId: planWorker.panelId },
      );
      const bouncedAcceptance = run.acceptance.map((item) =>
        caseIds.includes(item.caseId)
          ? { ...item, bouncedToPanelId: planWorker.panelId }
          : item,
      );
      return this.updateRun(run, {
        acceptance: bouncedAcceptance,
        activeWorkerRole: "plan",
        workers: setActiveWorker(run.workers, "plan"),
        logs: [
          ...run.logs,
          `计划审查用例 ${caseIds.join(", ")} 稳定失败，抛回 plan pane ${planWorker.panelId}`,
        ],
      });
    } catch (error) {
      agentTeamLogger.warn("agent-team.plan_bounce.failed", {
        message: "Could not bounce plan failure back to plan pane",
        runId: run.runId,
        error,
      });
      return run;
    }
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
        activeWorkerRole: "code",
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
    if (
      !run ||
      (run.phase !== "executing" && run.phase !== "plan_review") ||
      run.status !== "running"
    ) {
      return;
    }
    const outbox = await this.outboxResolver.resolveOutbox(event);
    if (!outbox) {
      return;
    }
    const initialRound = this.resolveOutboxRound(run, outbox);
    const shouldDispatchRecheck = this.hasBouncedCasesForWorker(run, outbox);
    const shouldDispatchSerial = shouldDispatchNextSerialWorker(run, outbox);
    if (
      !initialRound.acceptanceResults.length &&
      !shouldDispatchRecheck &&
      !shouldDispatchSerial
    ) {
      return;
    }
    this.incrementPendingCompletionRound(run.runId);
    await this.enqueue(run.runId, async () => {
      try {
        const latest = await this.getRun(run.runId);
        if (
          !latest ||
          (latest.phase !== "executing" && latest.phase !== "plan_review")
        ) {
          return;
        }
        if (!isActiveWorkerOutbox(latest, outbox)) {
          return;
        }
        if (await this.dispatchNextSerialWorkerFromCompletion(latest, outbox)) {
          return;
        }
        const round = this.resolveOutboxRound(latest, outbox);
        if (!round.acceptanceResults.length) {
          await this.dispatchBouncedCasesForRecheck(latest, outbox);
          return;
        }
        await this.applyRound(latest, {
          acceptanceResults: round.acceptanceResults,
          forceBounceCaseIds: round.forceBounceCaseIds,
          completedWorkerRole: parseWorkerRole(outbox.role),
        });
      } finally {
        this.decrementPendingCompletionRound(run.runId);
      }
    });
  }

  private hasBouncedCasesForWorker(
    run: AgentTeamRun,
    outbox: AgentTeamWorkerOutbox,
  ): boolean {
    return this.findBouncedCasesForWorker(run, outbox).length > 0;
  }

  private findBouncedCasesForWorker(
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

  private async dispatchBouncedCasesForRecheck(
    run: AgentTeamRun,
    outbox: AgentTeamWorkerOutbox,
  ): Promise<AgentTeamRun> {
    const cases = this.findBouncedCasesForWorker(run, outbox);
    if (cases.length === 0) {
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
    const dispatches = resolveRecheckDispatches(run, cases);
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
          { attempt: 1, sourcePanelId: outbox.panelId ?? null },
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

  private async dispatchNextSerialWorkerFromCompletion(
    run: AgentTeamRun,
    outbox: AgentTeamWorkerOutbox,
  ): Promise<boolean> {
    const role = parseWorkerRole(outbox.role);
    if (!role) {
      return false;
    }
    if (run.phase === "plan_review" && role === "plan") {
      await this.dispatchSerialWorker(run, "plan_review", {
        cases: run.acceptance,
        log: "plan 修复完成，启动 plan_review",
      });
      return true;
    }
    if (run.phase === "executing" && role === "code") {
      await this.dispatchSerialWorker(run, "code_review", {
        cases: acceptanceCasesForRole(run, "code_review"),
        log: "code 完成，启动 code_review",
      });
      return true;
    }
    return false;
  }

  private async dispatchSerialWorker(
    run: AgentTeamRun,
    role: AgentTeamWorkerRole,
    options: { cases: AgentTeamAcceptanceCase[]; log: string },
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
    await this.promptSender.sendPromptToPane(
      session,
      buildWorkerRecheckPrompt({
        run,
        worker,
        cases: options.cases,
        outboxPath,
      }),
      { panelId: worker.panelId },
    );

    const now = new Date().toISOString();
    const caseIds = new Set(options.cases.map((item) => item.caseId));
    return this.updateRun(run, {
      activeWorkerRole: role,
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
      logs: [
        ...run.logs,
        `${options.log}（${role} pane ${worker.panelId}）`,
      ],
    });
  }

  private async sendRecheckToWorker(
    run: AgentTeamRun,
    session: TerminalSessionRecord,
    worker: AgentTeamWorker,
    cases: AgentTeamAcceptanceCase[],
    options: {
      attempt: number;
      sourcePanelId?: string | null;
      reason?: "timeout_retry";
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
    const outboxMtimeMs = await this.readWorkerOutboxMtimeMs(
      session,
      worker,
    );
    await this.promptSender.sendPromptToPane(
      session,
      buildWorkerRecheckPrompt({
        run,
        worker,
        cases,
        outboxPath,
      }),
      { panelId: worker.panelId },
    );

    const now = new Date().toISOString();
    const caseIds = new Set(cases.map((item) => item.caseId));
    const logPrefix =
      options.reason === "timeout_retry"
        ? `复验 worker 超时，已重试触发用例`
        : `code pane ${options.sourcePanelId ?? ""} 已完成，重新触发用例`;
    return this.updateRun(run, {
      activeWorkerRole: worker.role,
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

  private startRecheckWatchdog(): void {
    if (this.recheckWatchdogTimer) {
      return;
    }
    this.recheckWatchdogTimer = setInterval(() => {
      void this.runRecheckWatchdog().catch((error) => {
        agentTeamLogger.warn("agent-team.recheck_watchdog.failed", {
          message: "Could not scan pending rechecks",
          error,
        });
      });
    }, RECHECK_WATCHDOG_INTERVAL_MS);
    this.recheckWatchdogTimer.unref?.();
  }

  private async runRecheckWatchdog(): Promise<void> {
    const projects = this.terminalSessionManager.listProjects();
    for (const project of projects) {
      const runs = await this.runStore.listRuns(project.id);
      for (const run of runs) {
        if (
          (run.phase !== "executing" && run.phase !== "plan_review") ||
          run.status !== "running"
        ) {
          continue;
        }
        if (findRecheckWatchdogCases(run).length === 0) {
          continue;
        }
        await this.enqueue(run.runId, async () => {
          const latest = await this.getRun(run.runId);
          if (
            !latest ||
            (latest.phase !== "executing" && latest.phase !== "plan_review") ||
            latest.status !== "running"
          ) {
            return;
          }
          await this.handleTimedOutRechecks(latest);
        });
      }
    }
  }

  private async handleTimedOutRechecks(run: AgentTeamRun): Promise<AgentTeamRun> {
    const overdueCases = findRecheckWatchdogCases(run);
    if (overdueCases.length === 0) {
      return run;
    }

    const completedOutbox = await this.resolveUpdatedRecheckOutbox(
      run,
      overdueCases,
    );
    if (completedOutbox) {
      const round = this.resolveOutboxRound(run, completedOutbox);
      if (round.acceptanceResults.length > 0) {
        return this.applyRound(run, {
          acceptanceResults: round.acceptanceResults,
          forceBounceCaseIds: round.forceBounceCaseIds,
          completedWorkerRole: parseWorkerRole(completedOutbox.role),
        });
      }
    }

    const exhaustedCases = overdueCases.filter(
      (item) => (item.recheckAttempt ?? 0) >= MAX_RECHECK_ATTEMPTS,
    );
    const retryCases = overdueCases.filter(
      (item) => (item.recheckAttempt ?? 0) < MAX_RECHECK_ATTEMPTS,
    );

    let latestRun = run;
    if (retryCases.length > 0) {
      latestRun = await this.retryTimedOutRechecks(latestRun, retryCases);
    }
    if (exhaustedCases.length === 0) {
      return latestRun;
    }
    return this.updateRun(latestRun, {
      status: "need_human",
      activeWorkerRole: null,
      workers: latestRun.workers.map((worker) => ({ ...worker, frozen: true })),
      acceptance: latestRun.acceptance.map((item) =>
        exhaustedCases.some((exhausted) => exhausted.caseId === item.caseId)
          ? {
              ...item,
              status: "fail" as const,
              consecutiveFail: latestRun.loop.stableFailThreshold,
              evidence:
                item.evidence.length > 0
                  ? item.evidence
                  : [
                      {
                        type: "text" as const,
                        label: "复验超时",
                        summary: `worker ${item.recheckWorkerPanelId ?? "unknown"} 连续 ${MAX_RECHECK_ATTEMPTS} 次未更新 outbox`,
                        detail: `超过 ${RECHECK_TIMEOUT_MS / 1000}s 未产出复验结果，已升级人工处理。`,
                        ref: `recheck watchdog: worker ${item.recheckWorkerPanelId ?? "unknown"} did not update outbox within ${RECHECK_TIMEOUT_MS / 1000}s after ${MAX_RECHECK_ATTEMPTS} attempts`,
                      },
                    ],
              recheckRequestedAt: null,
              recheckWorkerPanelId: null,
              recheckWorkerRole: null,
              recheckOutboxMtimeMs: null,
              recheckAttempt: 0,
            }
          : item,
      ),
      logs: [
        ...latestRun.logs,
        `⏸ 复验 worker 连续 ${MAX_RECHECK_ATTEMPTS} 次未产出 outbox，升级人工：${exhaustedCases.map((item) => item.caseId).join(", ")}`,
      ],
    });
  }

  private async resolveUpdatedRecheckOutbox(
    run: AgentTeamRun,
    cases: AgentTeamAcceptanceCase[],
  ): Promise<AgentTeamWorkerOutbox | null> {
    const session = this.terminalSessionManager.getSession(
      run.terminalSessionId,
    );
    if (!session) {
      return null;
    }
    for (const item of cases) {
      if (item.recheckOutboxMtimeMs === null || item.recheckOutboxMtimeMs === undefined) {
        continue;
      }
      const worker =
        this.findRecheckWorker(run, item) ??
        resolveRecheckDispatches(run, [item])[0]?.worker ??
        null;
      if (!worker?.panelId) {
        continue;
      }
      const outboxMtimeMs = await this.readWorkerOutboxMtimeMs(session, worker);
      if (
        outboxMtimeMs === null ||
        outboxMtimeMs <= item.recheckOutboxMtimeMs
      ) {
        continue;
      }
      const outbox = await this.outboxResolver.resolveOutbox(
        createSyntheticCompletionEvent(run, session, worker),
      );
      if (!outbox) {
        continue;
      }
      const round = this.resolveOutboxRound(run, outbox);
      if (round.acceptanceResults.some((result) => result.caseId === item.caseId)) {
        return outbox;
      }
    }
    return null;
  }

  private async retryTimedOutRechecks(
    run: AgentTeamRun,
    cases: AgentTeamAcceptanceCase[],
  ): Promise<AgentTeamRun> {
    const session = this.terminalSessionManager.getSession(
      run.terminalSessionId,
    );
    if (!session) {
      return run;
    }
    let latestRun = run;
    for (const group of groupRecheckCasesByWorker(cases)) {
      const worker =
        this.findRecheckWorker(latestRun, group[0]!) ??
        resolveRecheckDispatches(latestRun, [group[0]!])[0]?.worker ??
        null;
      if (!worker?.panelId) {
        continue;
      }
      const attempt = Math.max(
        ...group.map((item) => item.recheckAttempt ?? 0),
      ) + 1;
      const refreshed = await this.replaceWorkerPaneForRecheck(
        latestRun,
        session,
        worker,
        attempt,
      );
      latestRun = refreshed.run;
      try {
        latestRun = await this.sendRecheckToWorker(
          latestRun,
          session,
          refreshed.worker,
          group,
          { attempt, reason: "timeout_retry" },
        );
      } catch (error) {
        agentTeamLogger.warn("agent-team.recheck_retry.failed", {
          message: "Could not dispatch timed-out recheck",
          runId: latestRun.runId,
          role: refreshed.worker.role,
          panelId: refreshed.worker.panelId,
          attempt,
          error,
        });
        latestRun = await this.markRecheckDispatchFailed(
          latestRun,
          session,
          refreshed.worker,
          group,
          attempt,
        );
      }
    }
    return latestRun;
  }

  private async markRecheckDispatchFailed(
    run: AgentTeamRun,
    session: TerminalSessionRecord,
    worker: AgentTeamWorker,
    cases: AgentTeamAcceptanceCase[],
    attempt: number,
  ): Promise<AgentTeamRun> {
    const now = new Date().toISOString();
    const caseIds = new Set(cases.map((item) => item.caseId));
    const outboxMtimeMs = await this.readWorkerOutboxMtimeMs(session, worker);
    return this.updateRun(run, {
      acceptance: run.acceptance.map((item) =>
        caseIds.has(item.caseId)
          ? {
              ...item,
              status: "pending" as const,
              bouncedToPanelId: null,
              recheckRequestedAt: now,
              recheckWorkerPanelId: worker.panelId ?? null,
              recheckWorkerRole: worker.role,
              recheckOutboxMtimeMs: outboxMtimeMs,
              recheckAttempt: attempt,
            }
          : item,
      ),
      logs: [
        ...run.logs,
        `复验 worker ${worker.role} pane ${worker.panelId ?? ""} 投递失败，已记录 attempt ${attempt}：${Array.from(caseIds).join(", ")}`,
      ],
    });
  }

  private async replaceWorkerPaneForRecheck(
    run: AgentTeamRun,
    session: TerminalSessionRecord,
    worker: AgentTeamWorker,
    attempt: number,
  ): Promise<{ run: AgentTeamRun; worker: AgentTeamWorker }> {
    if (!this.tmuxService) {
      return { run, worker };
    }
    try {
      const suffix = `${worker.role}-retry-${Date.now().toString(36).slice(-6)}`;
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
          sourcePanelId: worker.panelId ?? undefined,
          direction: attempt % 2 === 0 ? "down" : "right",
          role: suffix,
          alias: suffix,
          agentTeamRunId: run.runId,
          agentTeamWorkerId: worker.id,
          cwd: run.terminal.cwd ?? undefined,
          focus: false,
        },
      );
      const replacement = {
        ...worker,
        panelId: panel.id,
        tmuxPaneId: panel.tmuxPaneId,
      };
      const nextRun = await this.updateRun(run, {
        workers: run.workers.map((item) =>
          item.id === worker.id ? replacement : item,
        ),
        logs: [
          ...run.logs,
          `复验 worker ${worker.role} pane ${worker.panelId} 超时，已切换到 fresh pane ${panel.id}`,
        ],
      });
      return { run: nextRun, worker: replacement };
    } catch (error) {
      agentTeamLogger.warn("agent-team.recheck_worker_replace.failed", {
        message: "Could not create replacement worker pane for recheck",
        runId: run.runId,
        role: worker.role,
        panelId: worker.panelId,
        error,
      });
      return { run, worker };
    }
  }

  private findRecheckWorker(
    run: AgentTeamRun,
    acceptanceCase: AgentTeamAcceptanceCase,
  ): AgentTeamWorker | null {
    return (
      run.workers.find(
        (worker) =>
          worker.panelId === acceptanceCase.recheckWorkerPanelId ||
          worker.role === acceptanceCase.recheckWorkerRole,
      ) ?? null
    );
  }

  private async readWorkerOutboxMtimeMs(
    session: TerminalSessionRecord,
    worker: Pick<AgentTeamWorker, "panelId" | "tmuxPaneId">,
  ): Promise<number | null> {
    try {
      const fileStat = await stat(
        this.paths.workerOutboxPath(
          session.projectId,
          session.id,
          worker,
          session.cwd,
        ),
      );
      return fileStat.mtimeMs;
    } catch {
      return null;
    }
  }

  private resolveOutboxRound(
    run: AgentTeamRun,
    outbox: AgentTeamWorkerOutbox,
  ): {
    acceptanceResults: NonNullable<AgentTeamWorkerOutbox["acceptanceResults"]>;
    forceBounceCaseIds: string[];
  } {
    const runWithGates = {
      ...run,
      acceptance: ensureWorkerGateAcceptance(run.workers, run.acceptance),
    };
    const knownCaseIds = new Set(
      runWithGates.acceptance.map((item) => item.caseId),
    );
    const directResults = (outbox.acceptanceResults ?? []).filter((result) =>
      knownCaseIds.has(result.caseId),
    );
    if (directResults.length > 0) {
      return {
        acceptanceResults: directResults,
        forceBounceCaseIds: isGateWorkerOutbox(outbox)
          ? directResults
              .filter((result) => result.status === "fail")
              .map((result) => result.caseId)
          : [],
      };
    }
    const reviewResult = synthesizeBlockingReviewResult(runWithGates, outbox);
    return reviewResult
      ? {
          acceptanceResults: [reviewResult],
          forceBounceCaseIds: [reviewResult.caseId],
        }
      : { acceptanceResults: [], forceBounceCaseIds: [] };
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
        | "planFile"
        | "activeWorkerRole"
        | "clarify"
        | "proposal"
        | "workers"
        | "acceptance"
        | "loop"
	        | "humanNotes"
	        | "scopeSnapshot"
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
const EXECUTION_WORKER_ORDER: AgentTeamWorkerRole[] = [
  "code",
  "code_review",
  "behavior_verify",
];

function buildAgentTeamPanelRole(
  runId: string,
  role: AgentTeamWorkerRole,
): string {
  return `agent-team:${runId}:${role}`;
}

function parseWorkerRole(role: string | null | undefined): AgentTeamWorkerRole | null {
  return VALID_WORKER_ROLES.includes(role as AgentTeamWorkerRole)
    ? (role as AgentTeamWorkerRole)
    : null;
}

function parseWorkerRoleFromPanelRole(
  runId: string,
  role: string | null | undefined,
): AgentTeamWorkerRole | null {
  const prefix = `agent-team:${runId}:`;
  if (!role?.startsWith(prefix)) {
    return null;
  }
  return parseWorkerRole(role.slice(prefix.length));
}

function clampExportTailLines(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_EXPORT_TAIL_LINES;
  }
  return Math.min(Math.max(Math.trunc(value), 1), MAX_EXPORT_TAIL_LINES);
}

function resolveInitialActiveWorkerRole(
  workers: AgentTeamWorker[],
): AgentTeamWorkerRole | null {
  for (const role of EXECUTION_WORKER_ORDER) {
    if (workers.some((worker) => worker.role === role && worker.panelId)) {
      return role;
    }
  }
  return workers.find((worker) => worker.panelId)?.role ?? null;
}

function findWorkerByRole(
  workers: AgentTeamWorker[],
  role: AgentTeamWorkerRole,
): AgentTeamWorker | null {
  return workers.find((worker) => worker.role === role && worker.panelId) ?? null;
}

function setActiveWorker(
  workers: AgentTeamWorker[],
  activeWorkerRole: AgentTeamWorkerRole | null,
): AgentTeamWorker[] {
  return workers.map((worker) => ({
    ...worker,
    frozen: !activeWorkerRole || worker.role !== activeWorkerRole,
  }));
}

function shouldDispatchNextSerialWorker(
  run: AgentTeamRun,
  outbox: AgentTeamWorkerOutbox,
): boolean {
  if (outbox.status !== "completed") {
    return false;
  }
  const role = parseWorkerRole(outbox.role);
  return (
    (run.phase === "plan_review" && role === "plan") ||
    (run.phase === "executing" && role === "code")
  );
}

function isActiveWorkerOutbox(
  run: AgentTeamRun,
  outbox: AgentTeamWorkerOutbox,
): boolean {
  const role = parseWorkerRole(outbox.role);
  if (!role || !run.activeWorkerRole) {
    return true;
  }
  return role === run.activeWorkerRole;
}

function acceptanceCasesForRole(
  run: AgentTeamRun,
  role: AgentTeamWorkerRole,
): AgentTeamAcceptanceCase[] {
  const acceptance = ensureWorkerGateAcceptance(run.workers, run.acceptance);
  if (role === "code_review") {
    return acceptance.filter(isReviewGateAcceptanceCase);
  }
  if (role === "behavior_verify") {
    return acceptance.filter((item) => !isReviewGateAcceptanceCase(item));
  }
  return acceptance;
}

function hasRolePassed(
  run: AgentTeamRun,
  role: AgentTeamWorkerRole,
): boolean {
  const cases = acceptanceCasesForRole(run, role);
  return cases.length > 0 && cases.every((item) => item.status === "pass");
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

function isUnbouncedFailCase(run: AgentTeamRun, caseId: string): boolean {
  const acceptanceCase = run.acceptance.find((item) => item.caseId === caseId);
  return Boolean(
    acceptanceCase &&
      acceptanceCase.status === "fail" &&
      !acceptanceCase.bouncedToPanelId,
  );
}

function mergeCaseIds(first: string[], second: string[]): string[] {
  return Array.from(new Set([...first, ...second]));
}

function ensureWorkerGateAcceptance(
  workers: AgentTeamWorker[],
  acceptance: AgentTeamAcceptanceCase[],
): AgentTeamAcceptanceCase[] {
  if (!workers.some((worker) => worker.role === "code_review")) {
    return acceptance;
  }
  if (acceptance.some(isReviewGateAcceptanceCase)) {
    return acceptance;
  }
  return [
    ...acceptance,
    {
      caseId: `case_${acceptance.length + 1}`,
      text: "Code Review 未发现阻断性问题（P0/P1），或阻断问题已修复",
      status: "pending",
      consecutiveFail: 0,
      evidence: [],
      bouncedToPanelId: null,
      recheckRequestedAt: null,
      recheckWorkerPanelId: null,
      recheckWorkerRole: null,
      recheckOutboxMtimeMs: null,
      recheckAttempt: 0,
    },
  ];
}

function normalizePlanReviewAcceptance(planFile: string): AgentTeamAcceptanceCase[] {
  return [
    {
      text: `计划文件 ${planFile} 范围清晰、可执行，且每个步骤都有明确验收方式`,
    },
    {
      text: "计划未引入无关改动、人工 gate 或与当前仓库约束冲突的测试方式",
    },
  ].map((item, index) => ({
    caseId: `plan_case_${index + 1}`,
    text: item.text,
    status: "pending" as const,
    consecutiveFail: 0,
    evidence: [],
    bouncedToPanelId: null,
    recheckRequestedAt: null,
    recheckWorkerPanelId: null,
    recheckWorkerRole: null,
    recheckOutboxMtimeMs: null,
    recheckAttempt: 0,
  }));
}

function buildPlanReviewEscalationReason(noProgressCount: number): string {
  return `计划修复无进展，连续 ${noProgressCount} 轮未通过 plan_review，自动熔断升级人工。`;
}

function isReviewGateAcceptanceCase(item: AgentTeamAcceptanceCase): boolean {
  return /code review|代码审查|code_review/i.test(item.text);
}

function synthesizeBlockingReviewResult(
  run: AgentTeamRun,
  outbox: AgentTeamWorkerOutbox,
): NonNullable<AgentTeamWorkerOutbox["acceptanceResults"]>[number] | null {
  if (!isReviewWorkerOutbox(outbox)) {
    return null;
  }
  const summary = summarizeBlockingReviewFindings(outbox);
  if (!summary) {
    return null;
  }
  const target =
    run.acceptance.find(isReviewGateAcceptanceCase) ?? run.acceptance[0];
  if (!target) {
    return null;
  }
  return {
    caseId: target.caseId,
    status: "fail",
    evidence: [
      {
        type: "text",
        label: "审查阻断",
        summary: `${outbox.role} 发现阻断问题：${summary}`,
        ref: `${outbox.role} blocker: ${summary}`,
      },
    ],
  };
}

function isReviewWorkerOutbox(outbox: AgentTeamWorkerOutbox): boolean {
  return outbox.role === "code_review" || outbox.role === "plan_review";
}

function isGateWorkerOutbox(outbox: AgentTeamWorkerOutbox): boolean {
  return isReviewWorkerOutbox(outbox) || outbox.role === "behavior_verify";
}

function isImplementationWorkerOutbox(outbox: AgentTeamWorkerOutbox): boolean {
  return outbox.role === "code" || outbox.role === "plan";
}

function resolveRecheckDispatches(
  run: AgentTeamRun,
  cases: AgentTeamAcceptanceCase[],
): Array<{ worker: AgentTeamWorker; cases: AgentTeamAcceptanceCase[] }> {
  const dispatches: Array<{
    worker: AgentTeamWorker;
    cases: AgentTeamAcceptanceCase[];
  }> = [];
  if (run.phase === "plan_review") {
    const planReviewWorker =
      run.workers.find(
        (worker) =>
          worker.role === "plan_review" && worker.panelId && !worker.frozen,
      ) ?? null;
    return planReviewWorker ? [{ worker: planReviewWorker, cases }] : [];
  }
  const reviewCases = cases.filter(isReviewGateAcceptanceCase);
  const behaviorCases = cases.filter((item) => !isReviewGateAcceptanceCase(item));
  const reviewWorker =
    run.workers.find(
      (worker) =>
        (worker.role === "code_review" || worker.role === "plan_review") &&
        worker.panelId &&
        !worker.frozen,
    ) ?? null;
  const behaviorWorker =
    run.workers.find(
      (worker) =>
        worker.role === "behavior_verify" && worker.panelId && !worker.frozen,
    ) ?? null;

  if (reviewCases.length > 0 && reviewWorker) {
    dispatches.push({ worker: reviewWorker, cases: reviewCases });
  }
  if (behaviorCases.length > 0 && behaviorWorker) {
    dispatches.push({ worker: behaviorWorker, cases: behaviorCases });
  }
  return dispatches;
}

function hasPendingRecheckRequest(item: AgentTeamAcceptanceCase): boolean {
  return Boolean(item.recheckRequestedAt && item.status === "pending");
}

function findRecheckWatchdogCases(
  run: AgentTeamRun,
): AgentTeamAcceptanceCase[] {
  return run.acceptance.filter(
    (item) => isOverdueRecheckCase(item) || isLegacyOverdueRecheckCase(run, item),
  );
}

function isOverdueRecheckCase(item: AgentTeamAcceptanceCase): boolean {
  if (!hasPendingRecheckRequest(item)) {
    return false;
  }
  const requestedAt = Date.parse(item.recheckRequestedAt!);
  return (
    Number.isFinite(requestedAt) &&
    Date.now() - requestedAt >= RECHECK_TIMEOUT_MS
  );
}

function isLegacyOverdueRecheckCase(
  run: AgentTeamRun,
  item: AgentTeamAcceptanceCase,
): boolean {
  if (item.status !== "pending" || item.recheckRequestedAt) {
    return false;
  }
  if (
    !run.logs.some(
      (log) => log.includes("复验") && log.includes(`用例 ${item.caseId}`),
    )
  ) {
    return false;
  }
  const updatedAt = Date.parse(run.updatedAt);
  return (
    Number.isFinite(updatedAt) && Date.now() - updatedAt >= RECHECK_TIMEOUT_MS
  );
}

function groupRecheckCasesByWorker(
  cases: AgentTeamAcceptanceCase[],
): AgentTeamAcceptanceCase[][] {
  const groups = new Map<string, AgentTeamAcceptanceCase[]>();
  for (const item of cases) {
    const key =
      item.recheckWorkerPanelId ?? item.recheckWorkerRole ?? item.caseId;
    const existing = groups.get(key);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return Array.from(groups.values());
}

function createSyntheticCompletionEvent(
  run: AgentTeamRun,
  session: TerminalSessionRecord,
  worker: Pick<AgentTeamWorker, "panelId" | "tmuxPaneId">,
): Extract<TerminalEventEnvelope, { kind: "completion" }> {
  const now = new Date().toISOString();
  return {
    id: `agent-team-recheck-watchdog-${run.runId}-${Date.now()}`,
    kind: "completion",
    terminalSessionId: run.terminalSessionId,
    projectId: run.projectId,
    createdAt: now,
    payload: {
      source: "codex",
      completionReason: "manual",
      commandName: run.terminal.command ?? null,
      rawHookEvent: null,
      hookEvent: "",
      cwd: session.cwd,
      outboxPath: null,
      summary: null,
      panelId: worker.panelId ?? null,
      tmuxPaneId: worker.tmuxPaneId ?? null,
    },
  };
}

function summarizeBlockingReviewFindings(
  outbox: AgentTeamWorkerOutbox,
): string | null {
  const remainingFindings = normalizeOutboxFindingList(
    outbox.remainingFindings,
    "open",
  );
  const blockingRemaining = remainingFindings
    .filter(isOpenBlockingFinding)
    .map(formatBlockingFindingSummary);
  if (blockingRemaining.length > 0) {
    return blockingRemaining.join("; ").slice(0, 500);
  }
  if (Array.isArray(outbox.remainingFindings)) {
    return null;
  }
  const legacyFindings = normalizeOutboxFindingList(
    (outbox as AgentTeamWorkerOutbox & {
      keyFindings?: unknown;
      findings?: unknown;
    }).keyFindings ??
      (outbox as AgentTeamWorkerOutbox & { findings?: unknown }).findings,
    "open",
  );
  const blockingLegacy = legacyFindings
    .filter(isOpenBlockingFinding)
    .map(formatBlockingFindingSummary);
  if (blockingLegacy.length > 0) {
    return blockingLegacy.join("; ").slice(0, 500);
  }
  const reviewText = outbox as AgentTeamWorkerOutbox & {
    conclusion?: unknown;
  };
  const fallback = [outbox.error, outbox.summary, reviewText.conclusion]
    .filter((item): item is string => Boolean(item))
    .join(" ");
  return /\bP0\b|\bP1\b|blocker|critical|阻断|严重/.test(fallback)
    ? fallback.slice(0, 500)
    : null;
}

function normalizeOutboxFindingList(
  findings: unknown,
  defaultStatus: AgentTeamFindingStatus,
): NonNullable<AgentTeamWorkerOutbox["remainingFindings"]> {
  if (!Array.isArray(findings)) {
    return [];
  }
  return findings
    .map((finding) => normalizeOutboxFinding(finding, defaultStatus))
    .filter((finding): finding is NonNullable<AgentTeamWorkerOutbox["remainingFindings"]>[number] =>
      Boolean(finding),
    );
}

function normalizeOutboxFinding(
  finding: unknown,
  defaultStatus: AgentTeamFindingStatus,
): NonNullable<AgentTeamWorkerOutbox["remainingFindings"]>[number] | null {
  if (!finding || typeof finding !== "object") {
    return null;
  }
  const record = finding as Record<string, unknown>;
  const severity =
    typeof record.severity === "string" ? record.severity.trim() : "";
  if (!/^(P0|P1|P2|P3)$/i.test(severity)) {
    return null;
  }
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  const impact = typeof record.impact === "string" ? record.impact.trim() : "";
  const resolvedSummary = summary || impact || title;
  if (!resolvedSummary) {
    return null;
  }
  const rawStatus =
    typeof record.status === "string" && record.status.trim()
      ? record.status.trim()
      : defaultStatus;
  const status =
    rawStatus === "resolved" || rawStatus === "informational" ? rawStatus : "open";
  return {
    severity: severity.toUpperCase() as "P0" | "P1" | "P2" | "P3",
    status,
    title: title || resolvedSummary.slice(0, 120),
    summary: resolvedSummary,
    ...(typeof record.ref === "string" && record.ref.trim()
      ? { ref: record.ref.trim() }
      : {}),
  };
}

function isOpenBlockingFinding(
  finding: NonNullable<AgentTeamWorkerOutbox["remainingFindings"]>[number],
): boolean {
  return (
    (finding.severity === "P0" || finding.severity === "P1") &&
    (finding.status ?? "open") === "open"
  );
}

function formatBlockingFindingSummary(
  finding: NonNullable<AgentTeamWorkerOutbox["remainingFindings"]>[number],
): string {
  return [finding.severity, finding.title || finding.summary]
    .filter(Boolean)
    .join(": ");
}

function buildExportAcceptanceSummary(
  run: AgentTeamRun,
  outboxes: AgentTeamExportOutbox[],
): AgentTeamExportResponse["acceptanceSummary"] {
  const outboxesByCase = new Map<string, AgentTeamWorkerOutbox[]>();
  for (const item of outboxes) {
    const outbox = item.outbox;
    if (!outbox?.acceptanceResults) {
      continue;
    }
    for (const result of outbox.acceptanceResults) {
      const current = outboxesByCase.get(result.caseId) ?? [];
      current.push(outbox);
      outboxesByCase.set(result.caseId, current);
    }
  }
  return run.acceptance.map((item) => {
    const caseOutboxes = outboxesByCase.get(item.caseId) ?? [];
    return {
      caseId: item.caseId,
      status: item.status,
      evidenceCount: item.evidence.length,
      sourceRoles: Array.from(
        new Set(
          caseOutboxes
            .map((outbox) => outbox.role)
            .filter((role): role is string => Boolean(role)),
        ),
      ),
      remainingFindingCount: caseOutboxes.reduce(
        (sum, outbox) =>
          sum + normalizeOutboxFindingList(outbox.remainingFindings, "open").length,
        0,
      ),
      resolvedFindingCount: caseOutboxes.reduce(
        (sum, outbox) =>
          sum +
          normalizeOutboxFindingList(outbox.resolvedFindings, "resolved").length,
        0,
      ),
    };
  });
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
          { role: "code" as const, intent: "实现任务目标中的核心改动" },
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
          { text: "核心改动按任务目标落地，页面/行为符合预期" },
          { text: "关键回归用例通过，无明显破坏" },
        ];
  return source.map((item, index) => ({
    caseId: `case_${index + 1}`,
    text: item.text?.trim() || `验收用例 ${index + 1}`,
    status: "pending" as const,
    consecutiveFail: 0,
    evidence: [],
    bouncedToPanelId: null,
    recheckRequestedAt: null,
    recheckWorkerPanelId: null,
    recheckWorkerRole: null,
    recheckOutboxMtimeMs: null,
    recheckAttempt: 0,
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
