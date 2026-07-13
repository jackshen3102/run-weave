import type {
  AgentTeamRun,
  CompleteAgentTeamRunRequest,
  CreateAgentTeamRunRequest,
  ProposeAgentTeamSplitRequest,
  RecordAgentTeamRoundRequest,
  ResumeAgentTeamRunRequest,
  SubmitAgentTeamSplitGateRequest,
} from "@runweave/shared/agent-team";
import { ensureTerminalPanelWorkspace } from "../terminal/application/panel-workspace";
import { AgentTeamError } from "./errors";
import { createAgentTeamRunId } from "./run-id";
import {
  buildHumanNotePrompt,
  buildMainTestCaseGenerationPrompt,
} from "./prompt-builders";
import { createInitialLoop } from "./loop";
import { resolveMaxRepairAttempts } from "./repair-loop";
import { agentTeamLogger } from "./service-context";
import { AgentTeamRecheckService } from "./service-recheck";
import {
  normalizeWorkers,
  resolveInitialActiveWorkerRole,
  setActiveWorker,
} from "./service-workflow-policy";
import {
  delay,
  formatErrorMessage,
  formatVerificationSource,
  isManualFeedbackRound,
  isStaleExpectedRound,
  requireRunnableTask,
  requireVerificationConfig,
  resolveAgentTeamTerminal,
} from "./service-run-policy";

const MANUAL_FEEDBACK_COMPLETION_GRACE_MS = 200;

export class AgentTeamLifecycleService extends AgentTeamRecheckService {
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
    const projectRoot = this.resolveRequiredProjectRoot(
      input.projectId,
      session.cwd,
    );
    const prepared = await this.prepareInitialAcceptance(input, projectRoot);
    const runId = createAgentTeamRunId(input.terminalSessionId);
    const reviewCheckpointMode =
      input.options?.reviewCheckpointMode ?? "disabled";
    const maxRepairAttempts = resolveMaxRepairAttempts(
      input.options?.maxRepairAttempts,
    );
    let reviewCheckpoint: AgentTeamRun["reviewCheckpoint"] = null;
    if (reviewCheckpointMode === "local_commit") {
      const preflight = await this.reviewCheckpointGit.preflight(projectRoot);
      for (const project of this.terminalSessionManager.listProjects()) {
        const runs = await this.runStore.listRuns(project.id);
        const owner = runs.find(
          (candidate) =>
            candidate.runId !== runId &&
            candidate.status !== "done" &&
            candidate.status !== "failed" &&
            candidate.reviewCheckpoint?.repoRoot === preflight.repoRoot,
        );
        if (owner) {
          throw new AgentTeamError(
            409,
            `当前 Git worktree 已被 checkpoint run ${owner.runId} 占用`,
          );
        }
      }
      const branch = buildReviewCheckpointBranch(runId);
      await this.reviewCheckpointGit.createRunBranch(
        preflight.repoRoot,
        branch,
      );
      reviewCheckpoint = {
        mode: "local_commit",
        repoRoot: preflight.repoRoot,
        originalBranch: preflight.originalBranch,
        branch,
        taskBaseCommit: preflight.taskBaseCommit,
        lastReviewedCommit: preflight.taskBaseCommit,
        pendingReview: null,
        checkpoints: [],
        finalReviewedCommit: null,
      };
    }
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
      runId,
      projectId: input.projectId,
      terminalSessionId: input.terminalSessionId,
      mainPanelId,
      phase: "intake",
      status: "running",
      options: {
        autoApproveSplit: input.options?.autoApproveSplit ?? false,
        reviewCheckpointMode,
        maxRepairAttempts,
      },
      terminal,
      task,
      verification: prepared.verification,
      reviewCheckpoint,
      activeWorkerRole: null,
      activeWorkerDispatch: null,
      clarify: [],
      proposal: null,
      workers: [],
      acceptance: [],
      loop: createInitialLoop(maxRepairAttempts),
      humanNotes: [],
      logs: [prepared.startLog],
      createdAt: now,
      updatedAt: now,
    };
    const workers = normalizeWorkers(undefined);
    const acceptance = prepared.acceptance;
    if (acceptance.length === 0) {
      await this.runStore.writeRun(run);
      try {
        await this.agentReadiness.ensureAgentReady(
          session,
          terminal,
          mainPanelId
            ? { panelId: mainPanelId, publishSessionState: true }
            : undefined,
        );
        await this.promptSender.sendPromptToPane(
          session,
          buildMainTestCaseGenerationPrompt({
            run,
            planFilePath: prepared.verification.planFilePath ?? null,
          }),
          mainPanelId ? { panelId: mainPanelId } : undefined,
        );
      } catch (error) {
        await this.updateRun(run, {
          status: "failed",
          logs: [
            ...run.logs,
            `主 Agent 测试案例生成指令注入失败：${formatErrorMessage(error)}`,
          ],
        });
        throw error;
      }
      return this.requireRun(run.runId);
    }
    const proposal = {
      summary: `任务已提交。${formatVerificationSource(prepared.verification)}，建议拆以下 worker：`,
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
    return await this.requireRun(run.runId);
  }

  // --- Phase 2: intake -> proposal (+ split gate) ---

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
    const prepared = await this.prepareSplitAcceptance(run, input);
    const acceptance = prepared.acceptance;
    const summary =
      input.summary?.trim() ||
      (source === "agent"
        ? `主 Agent 建议拆以下 worker。${formatVerificationSource(prepared.verification)}`
        : `任务已提交。${formatVerificationSource(prepared.verification)}，建议拆以下 worker：`);
    const runWithVerification = {
      ...run,
      verification: prepared.verification,
    };

    // Auto-approve short circuit: skip the human gate, go straight to executing.
    if (run.options.autoApproveSplit) {
      return this.applySplit(runWithVerification, workers, acceptance, {
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
      verification: prepared.verification,
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
    const prepared =
      input.acceptance ||
      input.testCaseFilePath ||
      input.generatedTestCaseFilePath ||
      input.planFilePath
        ? await this.prepareSplitAcceptance(run, input)
        : {
            acceptance: run.proposal.acceptance,
            verification: requireVerificationConfig(run.verification),
          };
    const acceptance = prepared.acceptance;
    if (workers.length === 0) {
      throw new AgentTeamError(400, "At least one worker is required");
    }
    requireRunnableTask(run.task);
    return this.applySplit(
      { ...run, verification: prepared.verification },
      workers,
      acceptance,
      {
        source: run.proposal.source,
        log: `人工确认拆分（${workers.length} worker），split pane`,
      },
    );
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
        objectiveProgress: input.hadDiff === true,
        observedNoProgress: input.hadDiff === false,
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
    const clearedRepairCycles = [...(run.loop.repairCycles ?? [])];
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
      activeWorkerDispatch: null,
      workers: setActiveWorker(run.workers, activeWorkerRole),
      loop: {
        ...run.loop,
        noProgressCount: 0,
        escalated: false,
        lastReason: null,
        errorFingerprints: [],
        bestPassCount: resumedBestPassCount,
        repairCycles: [],
        maxRepairAttempts:
          run.loop.maxRepairAttempts ??
          resolveMaxRepairAttempts(run.options.maxRepairAttempts),
      },
      acceptance: resumedAcceptance,
      humanNotes: [
        ...run.humanNotes,
        {
          id: `note_${Date.now()}`,
          at: now,
          text: note,
          clearedFingerprints,
          clearedRepairCycles,
        },
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
      activeWorkerDispatch: null,
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
        note ? `✅ 人工确认完成：${note}` : "✅ 人工确认完成，loop 已结束",
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
}

function buildReviewCheckpointBranch(runId: string): string {
  const suffix = runId.replace(/^atr_/, "").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `runweave/agt-${suffix}`;
}
