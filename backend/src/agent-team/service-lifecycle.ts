import { randomUUID } from "node:crypto";
import {
  resolveAgentTeamAcceptanceDecision,
  resolveAgentTeamAcceptanceObservedOutcome,
  type AgentTeamAcceptanceDisposition,
  type AgentTeamRun,
  type CompleteAgentTeamRunRequest,
  type CreateAgentTeamRunRequest,
  type DecideAgentTeamAcceptanceRequest,
  type ProposeAgentTeamSplitRequest,
  type ResumeAgentTeamRunRequest,
  type SubmitAgentTeamSplitGateRequest,
} from "@runweave/shared/agent-team";
import { ensureTerminalPanelWorkspace } from "../terminal/application/panel-workspace";
import { AgentTeamError } from "./errors";
import { createAgentTeamRunId } from "./run-id";
import {
  buildHumanNotePrompt,
  buildMainTestCaseGenerationPrompt,
} from "./prompt-builders";
import { createInitialLoop } from "./loop";
import {
  isTraceableProductCase,
  resolveMaxRepairAttempts,
} from "./repair-loop";
import { agentTeamLogger } from "./service-context";
import { AgentTeamFixtureLifecycleService } from "./service-fixture-lifecycle";
import {
  acceptanceCasesForRole,
  behaviorVerificationCasesForDispatch,
} from "./service-acceptance-policy";
import {
  normalizeWorkers,
  resolveInitialActiveWorkerRole,
  setActiveWorker,
} from "./service-workflow-policy";
import {
  formatErrorMessage,
  formatVerificationSource,
  requireRunnableTask,
  requireVerificationConfig,
  resolveAgentTeamTerminal,
} from "./service-run-policy";
import { isTerminalAgentTeamStatus } from "./service-fixture-support";
import {
  appendAgentTeamCompletionOutcome,
  evaluateAgentTeamCompletion,
  projectAgentTeamRunForRead,
} from "./service-completion-policy";

export class AgentTeamLifecycleService extends AgentTeamFixtureLifecycleService {
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
    const flow = input.options?.flow ?? "code_first";
    const stableFailThreshold = flow === "verify_first" ? 1 : undefined;
    const maxRepairAttempts = resolveMaxRepairAttempts(
      input.options?.maxRepairAttempts,
    );
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

  async completeRun(
    runId: string,
    input: CompleteAgentTeamRunRequest,
  ): Promise<AgentTeamRun> {
    return this.enqueue(runId, () => this.completeRunUnlocked(runId, input));
  }

  async decideAcceptance(
    runId: string,
    input: DecideAgentTeamAcceptanceRequest,
  ): Promise<AgentTeamRun> {
    return this.enqueue(runId, async () => {
      const storedRun = await this.requireRun(runId);
      if (
        storedRun.phase !== "executing" ||
        storedRun.status !== "need_human" ||
        storedRun.activeWorkerRole ||
        storedRun.activeWorkerDispatch
      ) {
        throw new AgentTeamError(
          409,
          "只有等待人工处理且没有 active dispatch 的 Run 可以裁决验收 Case",
        );
      }
      if (storedRun.pendingFindingDecision) {
        throw new AgentTeamError(409, "请先完成待处理的 review finding 裁决");
      }
      const run = projectAgentTeamRunForRead(storedRun);
      const caseId = input.caseId.trim();
      const acceptanceCase = run.acceptance.find(
        (item) => item.caseId === caseId,
      );
      if (!acceptanceCase || !isTraceableProductCase(acceptanceCase)) {
        throw new AgentTeamError(400, `${caseId} 不是可裁决的产品 Case`);
      }
      const observation = acceptanceCase.latestObservation;
      if (!observation || observation.outcome === "pass") {
        throw new AgentTeamError(409, `${caseId} 没有可裁决的未通过 observation`);
      }
      if (resolveAgentTeamAcceptanceDecision(run, acceptanceCase)) {
        throw new AgentTeamError(409, `${caseId} 的当前 observation 已完成人工裁决`);
      }
      if (
        input.disposition === "accepted_environment_skip" &&
        (observation.outcome !== "skipped" ||
          acceptanceCase.skip?.code !== "environment")
      ) {
        throw new AgentTeamError(
          409,
          `${caseId} 不是结构化 environment skip，不能确认环境跳过`,
        );
      }
      const reason = input.reason.trim();
      if (!reason) {
        throw new AgentTeamError(400, "验收 Case 裁决原因不能为空");
      }
      const now = new Date().toISOString();
      const decisionId = `acceptance_decision_${randomUUID()}`;
      const decision = {
        id: decisionId,
        caseId,
        disposition: input.disposition,
        reason,
        observation: { ...observation },
        decidedAt: now,
      };
      const acceptanceDecisions = [
        ...(run.acceptanceDecisions ?? []),
        decision,
      ];
      const decidedSnapshot = { ...run, acceptanceDecisions };
      const resolvedCaseIds = new Set(
        run.acceptance
          .filter(
            (item) =>
              resolveAgentTeamAcceptanceObservedOutcome(item) === "pass" ||
              Boolean(
                resolveAgentTeamAcceptanceDecision(decidedSnapshot, item),
              ),
          )
          .map((item) => item.caseId),
      );
      const repairCycles = (run.loop.repairCycles ?? []).flatMap((cycle) => {
        const caseIds = cycle.caseIds.filter(
          (item) => !resolvedCaseIds.has(item),
        );
        return caseIds.length > 0 ? [{ ...cycle, caseIds }] : [];
      });
      const frameworkRepairResolved =
        run.frameworkRepair?.result === "blocked" &&
        run.frameworkRepair.target.caseIds.every((item) =>
          resolvedCaseIds.has(item),
        );
      const frameworkRepair = frameworkRepairResolved && run.frameworkRepair
        ? {
            ...run.frameworkRepair,
            result: "continued" as const,
            pendingContinueDispatchId: null,
            continuedAt: now,
            continuedDispatchId: null,
          }
        : run.frameworkRepair;
      const dispositionLabel: Record<AgentTeamAcceptanceDisposition, string> = {
        accepted_environment_skip: "确认环境问题并跳过",
        invalid_case: "标记 Case 不适用",
      };
      const decidedRun = await this.updateRun(storedRun, {
        status: "need_human",
        acceptance: run.acceptance,
        acceptanceDecisions,
        frameworkRepair,
        loop: {
          ...run.loop,
          repairCycles,
          escalated: true,
          lastReason: null,
        },
        logs: [
          ...run.logs,
          `人工裁决验收 Case ${caseId}：${dispositionLabel[input.disposition]}；${reason}`,
          ...(frameworkRepairResolved
            ? ["人工裁决已解决框架修复关联 Case，解除 framework repair 阻断"]
            : []),
        ],
      });
      const evaluation = evaluateAgentTeamCompletion(decidedRun);
      if (evaluation.ready) {
        return this.completeRunUnlocked(runId, {});
      }
      if (
        evaluation.blockers.length === 1 &&
        evaluation.blockers[0]?.code === "final_review"
      ) {
        return this.dispatchSerialWorker(
          {
            ...decidedRun,
            status: "running",
            loop: { ...decidedRun.loop, escalated: false, lastReason: null },
          },
          "code_review",
          {
            cases: acceptanceCasesForRole(decidedRun, "code_review"),
            log: "人工裁决后产品 Case 已收口，启动最终全量 code_review",
            triggerSummary: `验收 Case ${caseId} 已人工裁决`,
            reviewScope: "final",
          },
        );
      }
      return this.updateRun(decidedRun, {
        loop: {
          ...decidedRun.loop,
          escalated: true,
          lastReason: evaluation.blockers
            .map((blocker) => blocker.message)
            .join("；"),
        },
      });
    });
  }

  private async completeRunUnlocked(
    runId: string,
    input: CompleteAgentTeamRunRequest,
  ): Promise<AgentTeamRun> {
    const run = await this.requireRun(runId);
    this.assertFrameworkRepairNotBlocked(run);
    if (run.phase !== "executing") {
      throw new AgentTeamError(409, "Run is not executing");
    }
    if (run.status === "done") {
      return projectAgentTeamRunForRead(run);
    }
    if (run.status === "failed") {
      throw new AgentTeamError(409, "Run has already failed");
    }
    if (run.status === "cancelled") {
      throw new AgentTeamError(
        409,
        "Cancelled fixture Run cannot be completed",
      );
    }
    const completionEvaluation = evaluateAgentTeamCompletion(run);
    if (!completionEvaluation.ready) {
      throw new AgentTeamError(
        409,
        `Run 尚未满足完成条件：${completionEvaluation.blockers
          .map((blocker) => blocker.message)
          .join("；")}`,
      );
    }
    const note = input.note?.trim();
    let fixtureCleanupHistory = run.fixtureCleanupHistory ?? [];
    if ((run.runKind ?? "primary") === "primary") {
      const cleanup = await this.reconcileOwnedFixtureResources(
        run,
        null,
        `owner Run ${run.runId} requested completion`,
      );
      fixtureCleanupHistory = [...fixtureCleanupHistory, cleanup];
      if (cleanup.status !== "completed") {
        const reason = formatFixtureCleanupBlocker(cleanup);
        return this.updateRun(run, {
          status: "need_human",
          workers: run.workers.map((worker) => ({ ...worker, frozen: true })),
          activeWorkerRole: null,
          activeWorkerDispatch: null,
          fixtureCleanupHistory,
          loop: {
            ...run.loop,
            escalated: true,
            lastReason: reason,
          },
          logs: [...run.logs, `⏸ ${reason}`],
        });
      }
    }
    const now = new Date().toISOString();
    const completionPatch = appendAgentTeamCompletionOutcome(run, {
      id: randomUUID(),
      result: completionEvaluation.result,
      exceptions: completionEvaluation.exceptions,
      trigger: "operator_finalize",
      finalizedAt: now,
    });
    return this.updateRun(run, {
      status: "done",
      ...completionPatch,
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
      fixtureCleanupHistory,
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

function formatFixtureCleanupBlocker(
  cleanup: NonNullable<AgentTeamRun["fixtureCleanupHistory"]>[number],
): string {
  const liveRuns = cleanup.ownedLiveFixtureRunIds.length;
  const blockedSessions = cleanup.devSessions.filter(
    (session) => session.error,
  ).length;
  return `fixture cleanup 未归零：ownedLiveFixtureRuns=${liveRuns}，blockedDevSessions=${blockedSessions}${cleanup.errors.length > 0 ? `；${cleanup.errors.join("; ")}` : ""}`;
}

function buildReviewCheckpointBranch(runId: string): string {
  const suffix = runId.replace(/^atr_/, "").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `runweave/agt-${suffix}`;
}
