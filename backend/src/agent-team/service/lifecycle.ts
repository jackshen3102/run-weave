import {
  type AgentTeamRun,
  type CreateAgentTeamRunRequest,
  type ProposeAgentTeamSplitRequest,
  type ResumeAgentTeamRunRequest,
  type SubmitAgentTeamSplitGateRequest,
} from "@runweave/shared/agent-team";
import { ensureTerminalPanelWorkspace } from "../../terminal/application/panel-workspace";
import { AgentTeamError } from "../errors";
import { createAgentTeamRunId } from "../run-id";
import {
  buildHumanNotePrompt,
  buildMainTestCaseGenerationPrompt,
} from "../prompt/builders";
import { createInitialLoop } from "../loop";
import { resolveMaxRepairAttempts } from "../repair/loop";
import { agentTeamLogger } from "./context";
import { AgentTeamRunCompletionService } from "./run-completion";
import {
  acceptanceCasesForRole,
  behaviorVerificationCasesForDispatch,
} from "./acceptance-policy";
import {
  normalizeWorkers,
  resolveInitialActiveWorkerRole,
  setActiveWorker,
} from "./workflow-policy";
import {
  formatErrorMessage,
  formatVerificationSource,
  requireRunnableTask,
  requireVerificationConfig,
} from "./run-policy";
import { isTerminalAgentTeamStatus } from "./fixture-support";
import {
  cloneAgentTeamRoleRuntimeSnapshot,
  createLegacyAgentTeamRoleRuntimeSnapshot,
  resolveAgentTeamRoleTerminal,
  resolveAgentTeamTerminal,
} from "../model-runtime";

export class AgentTeamLifecycleService extends AgentTeamRunCompletionService {
  async startRun(input: CreateAgentTeamRunRequest): Promise<AgentTeamRun> {
    const session = this.requireSession(input.terminalSessionId);
    const fixtureIdentity = await this.resolveRunFixtureIdentity(input);
    const existing = await this.runStore.getRunByTerminalSession(
      input.projectId,
      input.terminalSessionId,
    );
    if (existing && !isTerminalAgentTeamStatus(existing.status)) {
      throw new AgentTeamError(
        409,
        "This terminal already has an active agent-team run",
      );
    }
    const task = requireRunnableTask(input.task);
    const projectRoot = this.resolveRequiredProjectRoot(
      input.projectId,
      session.cwd,
    );
    const runtimeSource = await this.resolveStartRunRuntime(input);
    const terminal = runtimeSource.terminal;
    if (runtimeSource.requireShellIdle) {
      this.requireAgentTeamTerminalCommandSupported(terminal);
    } else {
      this.requireAgentTeamTerminalAvailable(session, terminal);
    }
    const prepared = await this.prepareInitialAcceptance(input, projectRoot);
    const runId = createAgentTeamRunId(input.terminalSessionId);
    const reviewCheckpointMode =
      input.options?.reviewCheckpointMode ?? "disabled";
    const flow = input.options?.flow ?? "code_first";
    const stableFailThreshold = flow === "verify_first" ? 1 : undefined;
    const maxRepairAttempts = resolveMaxRepairAttempts(
      input.options?.maxRepairAttempts,
    );
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
        const preferredMainPanel = runtimeSource.preferredMainPanelId
          ? this.terminalSessionManager.getPanel(
              runtimeSource.preferredMainPanelId,
            )
          : null;
        mainPanelId =
          preferredMainPanel?.terminalSessionId === session.id &&
          preferredMainPanel.status === "running"
            ? preferredMainPanel.id
            : (workspace?.activePanelId ?? null);
      } catch (error) {
        agentTeamLogger.warn("agent-team.start.panel_workspace_failed", {
          message: "Could not initialize panel workspace for run",
          terminalSessionId: session.id,
          error,
        });
      }
    }
    if (runtimeSource.requireShellIdle) {
      this.requireAgentTeamMainPanelShellIdle(session, mainPanelId);
    }
    let reviewCheckpoint: AgentTeamRun["reviewCheckpoint"] = null;
    if (reviewCheckpointMode === "local_commit") {
      const preflight = await this.reviewCheckpointGit.preflight(projectRoot);
      for (const project of this.terminalSessionManager.listAllProjectContexts()) {
        const runs = await this.runStore.listRuns(project.id);
        const owner = runs.find(
          (candidate) =>
            candidate.runId !== runId &&
            !isTerminalAgentTeamStatus(candidate.status) &&
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
    const now = new Date().toISOString();
    const run: AgentTeamRun = {
      runId,
      projectId: input.projectId,
      runKind: fixtureIdentity.runKind,
      lineage: fixtureIdentity.lineage,
      terminalSessionId: input.terminalSessionId,
      mainPanelId,
      phase: "intake",
      status: "running",
      options: {
        autoApproveSplit: input.options?.autoApproveSplit ?? false,
        notifyMainOnHumanGate: input.options?.notifyMainOnHumanGate ?? true,
        reviewCheckpointMode,
        maxRepairAttempts,
        flow,
      },
      terminal,
      roleRuntimes: runtimeSource.roleRuntimes,
      retryOfRunId: runtimeSource.retryOfRunId,
      task,
      verification: prepared.verification,
      reviewCheckpoint,
      activeWorkerRole: null,
      activeWorkerDispatch: null,
      workerDispatchProtocolVersion: 1,
      consumedWorkerDispatches: [],
      clarify: [],
      proposal: null,
      workers: [],
      acceptance: [],
      acceptanceDecisions: [],
      completionOutcome: null,
      completionHistory: [],
      loop: createInitialLoop(maxRepairAttempts, stableFailThreshold),
      humanNotes: [],
      findingDecisions: [],
      pendingFindingDecision: null,
      cancellation: null,
      fixtureResourceCleanup: null,
      fixtureCleanupHistory: [],
      logs: [prepared.startLog],
      createdAt: now,
      updatedAt: now,
    };
    const workers = normalizeWorkers(undefined);
    const acceptance = prepared.acceptance;
    if (acceptance.length === 0) {
      await this.runStore.writeRun(run);
      try {
        const generationPrompt = buildMainTestCaseGenerationPrompt({
          run,
          planFilePath: prepared.verification.planFilePath ?? null,
          testCaseValidationError: prepared.testCaseValidationError,
        });
        await this.agentLaunch.submitAgentLaunch(session, terminal, {
          panelId: mainPanelId,
          publishSessionState: true,
          prompt: generationPrompt,
        });
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
    return this.updateRun(run, {
      phase: "proposal",
      status: "need_human",
      proposal,
    });
  }

  private async resolveStartRunRuntime(
    input: CreateAgentTeamRunRequest,
  ): Promise<{
    terminal: AgentTeamRun["terminal"];
    roleRuntimes: AgentTeamRun["roleRuntimes"];
    retryOfRunId: string | null;
    preferredMainPanelId: string | null;
    requireShellIdle: boolean;
  }> {
    if (input.retryOfRunId && input.terminal) {
      throw new AgentTeamError(
        400,
        "retryOfRunId 与 terminal 不能同时作为运行时来源",
      );
    }
    if (input.retryOfRunId) {
      const source = await this.runStore.getRun(input.retryOfRunId);
      if (!source) {
        throw new AgentTeamError(404, "Retry source run not found");
      }
      if (
        source.projectId !== input.projectId ||
        source.terminalSessionId !== input.terminalSessionId
      ) {
        throw new AgentTeamError(
          409,
          "Retry source run must belong to the same Project and Terminal",
        );
      }
      if (source.status !== "failed") {
        throw new AgentTeamError(409, "Only a failed Run can be retried");
      }
      const capturedAt = new Date().toISOString();
      const roleRuntimes = source.roleRuntimes
        ? cloneAgentTeamRoleRuntimeSnapshot(source.roleRuntimes, {
            source: "retry_snapshot",
            capturedAt,
          })
        : createLegacyAgentTeamRoleRuntimeSnapshot(source.terminal, {
            source: "retry_snapshot",
            capturedAt,
          });
      return {
        terminal: resolveAgentTeamRoleTerminal(
          { terminal: source.terminal, roleRuntimes },
          "main",
        ),
        roleRuntimes,
        retryOfRunId: source.runId,
        preferredMainPanelId: source.mainPanelId ?? null,
        requireShellIdle: true,
      };
    }
    if (input.terminal) {
      return {
        terminal: resolveAgentTeamTerminal(input.terminal),
        roleRuntimes: undefined,
        retryOfRunId: null,
        preferredMainPanelId: null,
        requireShellIdle: false,
      };
    }
    const roleRuntimes = await this.requireModelSettingsService()
      .resolveGlobalRuntimeSnapshot();
    return {
      terminal: resolveAgentTeamRoleTerminal(
        { terminal: roleRuntimes.roles.main.terminal, roleRuntimes },
        "main",
      ),
      roleRuntimes,
      retryOfRunId: null,
      preferredMainPanelId: null,
      requireShellIdle: true,
    };
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
  // --- Phase 3: escalation -> resume ---
  async resumeRun(
    runId: string,
    input: ResumeAgentTeamRunRequest,
  ): Promise<AgentTeamRun> {
    const run = await this.requireRun(runId);
    this.assertFrameworkRepairNotBlocked(run);
    if (run.status === "cancelled" && run.runKind === "verification_fixture") {
      throw new AgentTeamError(409, "Cancelled fixture Run cannot be resumed");
    }
    if (run.pendingFindingDecision) {
      throw new AgentTeamError(
        409,
        "当前存在待裁决 review finding，请先选择 blocking、out_of_scope 或 waived",
      );
    }
    const note = input.note?.trim();
    if (!note) {
      throw new AgentTeamError(400, "A human intervention note is required");
    }
    const now = new Date().toISOString();
    const clearedFingerprints = [...run.loop.errorFingerprints];
    const clearedRepairCycles = [...(run.loop.repairCycles ?? [])];
    const lastRepairSourceRole = [...(run.consumedWorkerDispatches ?? [])]
      .reverse()
      .find((dispatch) => dispatch.role !== "code")?.role;
    const recoverableBehaviorRepairCycles =
      clearedRepairCycles.length === 0 &&
      lastRepairSourceRole === "behavior_verify"
        ? run.acceptance
            .filter((item) => item.status === "fail")
            .map((item) => ({
              repairKey: `behavior_verify:${item.caseId}`,
              sourceRole: "behavior_verify" as const,
              caseIds: [item.caseId],
              invariant: item.text,
              verificationMode: "runtime" as const,
              sourceEvidenceRefs: item.evidence.map((evidence) => evidence.ref),
              ...(item.reproduction
                ? { sourceReproduction: item.reproduction }
                : {}),
              attempts: 0,
              maxAttempts:
                run.loop.maxRepairAttempts ??
                resolveMaxRepairAttempts(run.options.maxRepairAttempts),
              firstFailedRound: run.loop.round,
              lastFailedRound: run.loop.round,
              lastFailureSummary: item.resultSummary ?? item.text,
            }))
        : [];
    const resumedRepairCycles = (
      clearedRepairCycles.length > 0
        ? clearedRepairCycles
        : recoverableBehaviorRepairCycles
    ).map((cycle) => ({
      ...cycle,
      attempts: 0,
    }));
    const resumedAcceptance = run.acceptance.map((item) => ({
      ...item,
      consecutiveFail: 0,
    }));
    const resumedBestPassCount = resumedAcceptance.filter(
      (item) => item.status === "pass",
    ).length;
    const activeWorkerRole =
      run.activeWorkerRole ??
      run.consumedWorkerDispatches?.at(-1)?.role ??
      resolveInitialActiveWorkerRole(
        run.workers,
        run.options.flow ?? "code_first",
      );
    const nextRun = await this.updateRun(run, {
      status: "running",
      cancellation: null,
      activeWorkerRole: null,
      activeWorkerDispatch: null,
      workers: setActiveWorker(run.workers, null),
      loop: {
        ...run.loop,
        noProgressCount: 0,
        escalated: false,
        lastReason: null,
        errorFingerprints: [],
        bestPassCount: resumedBestPassCount,
        repairCycles: resumedRepairCycles,
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
    if (!activeWorkerRole) {
      return this.pauseForRepairProtocolError(
        nextRun,
        "人工介入后无法恢复：没有可重新派发的 worker pane",
      );
    }
    const roleCases =
      activeWorkerRole === "behavior_verify"
        ? behaviorVerificationCasesForDispatch(nextRun)
        : acceptanceCasesForRole(nextRun, activeWorkerRole).filter(
            (item) => item.status !== "pass",
          );
    const failedCases = roleCases.filter((item) => item.status === "fail");
    if (activeWorkerRole === "code" && failedCases.length > 0) {
      return this.bounceFailuresToCode(
        nextRun,
        failedCases.map((item) => item.caseId),
      );
    }
    return this.dispatchSerialWorker(nextRun, activeWorkerRole, {
      cases: failedCases.length > 0 ? failedCases : roleCases,
      log: "人工介入后恢复，建立 fresh worker dispatch",
      triggerSummary: note,
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
