import { randomUUID } from "node:crypto";
import type {
  AgentTeamAcceptanceCase,
  AgentTeamFrameworkRepairRecoveryStatus,
  AgentTeamFrameworkRepairResponse,
  AgentTeamReviewCheckpointState,
  AgentTeamRun,
  BeginAgentTeamFrameworkRepairRequest,
} from "@runweave/shared/agent-team";
import type { TerminalSessionRecord } from "../terminal/manager";
import { AgentTeamError } from "./errors";
import { createInitialLoop } from "./loop";
import { buildFrameworkRepairContinuePrompt } from "./prompt-builders";
import { resolveMaxRepairAttempts } from "./repair-loop";
import { createAgentTeamRunId } from "./run-id";
import { acceptanceCasesForRole } from "./service-acceptance-policy";
import { AgentTeamLifecycleService } from "./service-lifecycle";
import {
  createActiveWorkerDispatch,
  findWorkerByRole,
  normalizeWorkers,
  setActiveWorker,
} from "./service-workflow-policy";

export class AgentTeamFrameworkRepairService extends AgentTeamLifecycleService {
  async getFrameworkRepairRecovery(
    runId: string,
  ): Promise<AgentTeamFrameworkRepairRecoveryStatus> {
    return this.buildFrameworkRepairRecoveryStatus(
      await this.requireRun(runId),
    );
  }

  async beginFrameworkRepair(
    runId: string,
    input: BeginAgentTeamFrameworkRepairRequest,
  ): Promise<AgentTeamFrameworkRepairResponse> {
    return this.enqueue(runId, async () => {
      const run = await this.requireRun(runId);
      if (run.frameworkRepair?.result === "blocked") {
        return this.frameworkRepairResponse(run);
      }
      if (run.phase !== "executing" || run.status !== "running") {
        throw new AgentTeamError(
          409,
          "只有正在执行且拥有 active dispatch 的 Run 可以开始框架修复",
        );
      }
      const reason = input.reason.trim();
      if (!reason) {
        throw new AgentTeamError(400, "框架阻塞原因不能为空");
      }
      const role = run.activeWorkerRole;
      const invalidatedDispatch = run.activeWorkerDispatch;
      const worker = role ? findWorkerByRole(run.workers, role) : null;
      if (!role || !worker || !invalidatedDispatch) {
        throw new AgentTeamError(
          409,
          "当前 Run 缺少可保存的 Worker dispatch 现场",
        );
      }
      const caseIds = acceptanceCasesForRole(run, role).map(
        (item) => item.caseId,
      );
      if (caseIds.length === 0) {
        throw new AgentTeamError(409, "当前 Worker 没有可恢复的验收 Case");
      }
      const begunAt = new Date().toISOString();
      const blockedRun = await this.updateRun(run, {
        status: "need_human",
        activeWorkerRole: null,
        activeWorkerDispatch: null,
        workers: setActiveWorker(run.workers, null),
        frameworkRepair: {
          repairId: `framework_repair_${randomUUID()}`,
          reason,
          begunAt,
          backendInstanceIdBefore: this.backendInstanceId,
          target: {
            role,
            caseIds,
            panelId: worker.panelId ?? null,
            tmuxPaneId: worker.tmuxPaneId ?? null,
            invalidatedDispatch: {
              ...invalidatedDispatch,
              checkpointAllowedDirtyPaths: [
                ...(invalidatedDispatch.checkpointAllowedDirtyPaths ?? []),
              ],
              repairKeys: [...(invalidatedDispatch.repairKeys ?? [])],
            },
          },
          result: "blocked",
        },
        logs: [
          ...run.logs,
          `⏸ 框架修复已开始：${reason}；旧 dispatch ${invalidatedDispatch.dispatchId ?? "unknown"} 已失效`,
        ],
      });
      return this.frameworkRepairResponse(blockedRun);
    });
  }

  async continueFrameworkRepair(
    runId: string,
  ): Promise<AgentTeamFrameworkRepairResponse> {
    return this.enqueue(runId, async () => {
      const run = await this.requireRun(runId);
      const recovery = this.buildFrameworkRepairRecoveryStatus(run);
      if (!recovery.canContinue) {
        throw new AgentTeamError(
          409,
          recovery.continueBlocker?.message ?? "当前框架修复现场不可继续",
        );
      }
      const repair = run.frameworkRepair!;
      const session = this.requireSession(run.terminalSessionId);
      const worker = run.workers.find(
        (item) =>
          item.role === repair.target.role &&
          item.panelId === repair.target.panelId &&
          item.tmuxPaneId === repair.target.tmuxPaneId,
      );
      if (!worker?.panelId) {
        throw new AgentTeamError(409, "目标 Worker pane 不可用");
      }
      const caseIdSet = new Set(repair.target.caseIds);
      const cases = run.acceptance.filter((item) => caseIdSet.has(item.caseId));
      const outboxMtimeMs = await this.readWorkerOutboxMtimeMs(session, worker);
      const requestedAt = new Date().toISOString();
      const activeWorkerDispatch = createActiveWorkerDispatch(
        worker,
        requestedAt,
        outboxMtimeMs,
        run.loop.round,
        worker.role === "code_review"
          ? (run.reviewCheckpoint?.pendingReview ?? null)
          : null,
        {
          repairKeys: [
            ...(repair.target.invalidatedDispatch.repairKeys ?? []),
          ],
        },
      );
      const dispatchRun: AgentTeamRun = {
        ...run,
        status: "need_human",
        activeWorkerRole: worker.role,
        activeWorkerDispatch,
        workers: setActiveWorker(run.workers, worker.role),
        frameworkRepair: {
          ...repair,
          pendingContinueDispatchId: activeWorkerDispatch.dispatchId ?? null,
        },
      };
      const preparedRun = await this.updateRun(run, {
        status: dispatchRun.status,
        activeWorkerRole: dispatchRun.activeWorkerRole,
        activeWorkerDispatch,
        workerDispatchProtocolVersion: 1,
        consumedWorkerDispatches: run.consumedWorkerDispatches ?? [],
        workers: dispatchRun.workers,
        frameworkRepair: dispatchRun.frameworkRepair,
      });
      const prompt = buildFrameworkRepairContinuePrompt({
        run: dispatchRun,
        worker,
        cases,
        outboxPath: this.paths.workerOutboxRelativePath(
          run.terminalSessionId,
          worker,
        ),
      });
      try {
        await this.submitWorkerDispatchPrompt(
          preparedRun,
          session,
          run.terminal,
          worker,
          prompt,
        );
      } catch (error) {
        try {
          await this.runStore.writeRun(run);
        } catch (rollbackError) {
          throw new AgentTeamError(
            409,
            `继续原 Run 投递失败，且 dispatch 保留待确认：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
        throw new AgentTeamError(
          409,
          `继续原 Run 投递失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const continuedAt = new Date().toISOString();
      let continuedRun: AgentTeamRun;
      try {
        continuedRun = await this.updateRun(preparedRun, {
          status: "running",
          activeWorkerRole: worker.role,
          activeWorkerDispatch,
          workerDispatchProtocolVersion: 1,
          consumedWorkerDispatches: run.consumedWorkerDispatches ?? [],
          workers: setActiveWorker(run.workers, worker.role),
          frameworkRepair: {
            ...repair,
            pendingContinueDispatchId: null,
            result: "continued",
            continuedAt,
            continuedDispatchId: activeWorkerDispatch.dispatchId ?? null,
          },
          logs: [
            ...run.logs,
            `▶ 框架修复后继续原 Run：${worker.role} ${repair.target.caseIds.join(", ")}；新 dispatch ${activeWorkerDispatch.dispatchId ?? "unknown"}`,
          ],
        });
      } catch (error) {
        throw new AgentTeamError(
          409,
          `继续原 Run 已投递待确认：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return this.frameworkRepairResponse(continuedRun);
    });
  }

  async rerunFrameworkRepair(
    runId: string,
  ): Promise<AgentTeamFrameworkRepairResponse> {
    return this.enqueue(runId, async () => {
      const run = await this.requireRun(runId);
      if (run.frameworkRepair?.result !== "blocked") {
        throw new AgentTeamError(409, "Run 当前不处于框架修复阻塞状态");
      }
      if (run.frameworkRepair.pendingContinueDispatchId) {
        throw new AgentTeamError(
          409,
          "继续原 Run 的 dispatch 已投递待确认，禁止重新运行",
        );
      }
      const session = this.requireSession(run.terminalSessionId);
      if (session.status !== "running") {
        throw new AgentTeamError(
          409,
          "原 terminal session 不可用，无法重新运行",
        );
      }
      await this.assertVerificationSourcesUnchanged(run);
      const newRunId = createAgentTeamRunId(
        `${randomUUID().slice(0, 8)}-${run.terminalSessionId}`,
      );
      const projectRoot = this.resolveRequiredProjectRoot(
        run.projectId,
        session.cwd,
      );
      const reviewCheckpoint = await this.createRerunReviewCheckpoint(
        newRunId,
        run,
        projectRoot,
      );
      const stableFailThreshold =
        (run.options.flow ?? "code_first") === "verify_first" ? 1 : undefined;
      const maxRepairAttempts = resolveMaxRepairAttempts(
        run.options.maxRepairAttempts,
      );
      const now = new Date().toISOString();
      const cleanRun: AgentTeamRun = {
        runId: newRunId,
        projectId: run.projectId,
        terminalSessionId: run.terminalSessionId,
        mainPanelId: run.mainPanelId ?? null,
        phase: "intake",
        status: "running",
        options: { ...run.options },
        terminal: {
          ...run.terminal,
          args: [...(run.terminal.args ?? [])],
        },
        task: run.task,
        verification: run.verification ? { ...run.verification } : null,
        reviewCheckpoint,
        activeWorkerRole: null,
        activeWorkerDispatch: null,
        workerDispatchProtocolVersion: 1,
        consumedWorkerDispatches: [],
        frameworkRepair: null,
        predecessorRunId: run.runId,
        successorRunId: null,
        clarify: [],
        proposal: null,
        workers: [],
        acceptance: [],
        loop: createInitialLoop(maxRepairAttempts, stableFailThreshold),
        humanNotes: [],
        agentInterventions: [],
        findingDecisions: [],
        pendingFindingDecision: null,
        logs: [`由框架修复 Run ${run.runId} 重新运行`],
        createdAt: now,
        updatedAt: now,
      };
      const workers = normalizeWorkers(
        run.workers.map((worker) => ({
          role: worker.role,
          intent: worker.intent,
        })),
      );
      let successor: AgentTeamRun;
      try {
        successor = await this.applySplit(
          cleanRun,
          workers,
          resetAcceptance(run.acceptance),
          {
            source: "agent",
            log: `框架修复后从 Run ${run.runId} 创建全新 Run`,
          },
        );
      } catch (error) {
        if (reviewCheckpoint) {
          try {
            await this.reviewCheckpointGit.rollbackRunBranch(
              reviewCheckpoint,
            );
          } catch (rollbackError) {
            throw new AgentTeamError(
              409,
              `重新运行创建失败，且 Git 现场回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            );
          }
        }
        throw error;
      }
      const rerunAt = new Date().toISOString();
      let finishedRun: AgentTeamRun;
      try {
        finishedRun = await this.updateRun(run, {
          status: "failed",
          activeWorkerRole: null,
          activeWorkerDispatch: null,
          workers: setActiveWorker(run.workers, null),
          frameworkRepair: {
            ...run.frameworkRepair,
            result: "rerun",
            rerunAt,
            successorRunId: successor.runId,
          },
          successorRunId: successor.runId,
          logs: [...run.logs, `↻ 框架修复后重新运行，新 Run：${successor.runId}`],
        });
      } catch (error) {
        const cleanupErrors = await this.rollbackRerunSuccessor(
          session,
          successor,
          reviewCheckpoint,
        );
        if (cleanupErrors.length > 0) {
          throw new AgentTeamError(
            409,
            `重新运行关联失败，且 successor 回滚不完整：${cleanupErrors.join("; ")}`,
          );
        }
        throw new AgentTeamError(
          409,
          `重新运行关联失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return this.frameworkRepairResponse(finishedRun, successor);
    });
  }

  private frameworkRepairResponse(
    run: AgentTeamRun,
    successorRun: AgentTeamRun | null = null,
  ): AgentTeamFrameworkRepairResponse {
    return {
      run,
      recovery: this.buildFrameworkRepairRecoveryStatus(run),
      successorRun,
    };
  }

  private async rollbackRerunSuccessor(
    session: TerminalSessionRecord,
    successor: AgentTeamRun,
    reviewCheckpoint: AgentTeamReviewCheckpointState | null,
  ): Promise<string[]> {
    const errors = await this.rollbackWorkerPanels(
      session,
      successor.workers
        .filter(
          (worker): worker is typeof worker & {
            panelId: string;
            tmuxPaneId: string;
          } => Boolean(worker.panelId && worker.tmuxPaneId),
        )
        .map((worker) => ({
          panelId: worker.panelId,
          tmuxPaneId: worker.tmuxPaneId,
        })),
    );
    await this.runStore.deleteRun(successor).catch((cleanupError: unknown) => {
      errors.push(
        `delete successor ${successor.runId}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    });
    if (reviewCheckpoint) {
      await this.reviewCheckpointGit
        .rollbackRunBranch(reviewCheckpoint)
        .catch((cleanupError: unknown) => {
          errors.push(
            `rollback successor branch: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        });
    }
    return errors;
  }

  private buildFrameworkRepairRecoveryStatus(
    run: AgentTeamRun,
  ): AgentTeamFrameworkRepairRecoveryStatus {
    const repair = run.frameworkRepair;
    if (!repair) {
      throw new AgentTeamError(409, "Run 没有框架修复现场");
    }
    const backendRestarted =
      repair.backendInstanceIdBefore !== this.backendInstanceId;
    if (repair.result !== "blocked") {
      return {
        runId: run.runId,
        repairId: repair.repairId,
        reason: repair.reason,
        result: repair.result,
        backendRestarted,
        canContinue: false,
        continueBlocker: {
          code: "repair_not_blocked",
          message: "框架修复已完成恢复决策",
        },
        actions: [],
        target: repair.target,
      };
    }
    if (repair.pendingContinueDispatchId) {
      return {
        runId: run.runId,
        repairId: repair.repairId,
        reason: repair.reason,
        result: repair.result,
        backendRestarted,
        canContinue: false,
        continueBlocker: {
          code: "continue_dispatch_pending",
          message: "继续原 Run 的 dispatch 已投递待确认，禁止重复派发",
        },
        actions: [],
        target: repair.target,
      };
    }
    const targetCases = new Set(repair.target.caseIds);
    const worker = run.workers.find(
      (item) =>
        item.role === repair.target.role &&
        item.panelId === repair.target.panelId &&
        item.tmuxPaneId === repair.target.tmuxPaneId,
    );
    const targetMissing =
      targetCases.size === 0 ||
      !worker?.panelId ||
      repair.target.caseIds.some(
        (caseId) => !run.acceptance.some((item) => item.caseId === caseId),
      );
    const session = this.terminalSessionManager.getSession(
      run.terminalSessionId,
    );
    const panel = repair.target.panelId
      ? this.terminalSessionManager.getPanel(repair.target.panelId)
      : null;
    const paneAvailable = Boolean(
      session?.status === "running" &&
      panel?.status === "running" &&
      panel.terminalSessionId === run.terminalSessionId &&
      panel.agentTeamRunId === run.runId &&
      panel.tmuxPaneId === repair.target.tmuxPaneId,
    );
    const continueBlocker = !backendRestarted
      ? {
          code: "backend_not_restarted" as const,
          message: "Backend 尚未完成重启",
        }
      : targetMissing
        ? {
            code: "recovery_target_missing" as const,
            message: "保存的 Worker role 或 Case 恢复目标不可识别",
          }
        : !paneAvailable
          ? {
              code: "worker_pane_unavailable" as const,
              message: "目标 Worker pane 不可用",
            }
          : null;
    return {
      runId: run.runId,
      repairId: repair.repairId,
      reason: repair.reason,
      result: repair.result,
      backendRestarted,
      canContinue: continueBlocker === null,
      continueBlocker,
      actions: ["continue", "rerun"],
      target: repair.target,
    };
  }

  private async createRerunReviewCheckpoint(
    newRunId: string,
    previousRun: AgentTeamRun,
    projectRoot: string,
  ): Promise<AgentTeamReviewCheckpointState | null> {
    if (previousRun.options.reviewCheckpointMode !== "local_commit") {
      return null;
    }
    const preflight = await this.reviewCheckpointGit.preflight(projectRoot);
    for (const project of this.terminalSessionManager.listProjects()) {
      const runs = await this.runStore.listRuns(project.id);
      const owner = runs.find(
        (candidate) =>
          candidate.runId !== previousRun.runId &&
          candidate.runId !== newRunId &&
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
    const branch = buildReviewCheckpointBranch(newRunId);
    await this.reviewCheckpointGit.createRunBranch(preflight.repoRoot, branch);
    return {
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
}

function resetAcceptance(
  acceptance: AgentTeamAcceptanceCase[],
): AgentTeamAcceptanceCase[] {
  return acceptance.map((item) => ({
    ...item,
    latestObservation: null,
    status: "pending",
    consecutiveFail: 0,
    lastRunStatus: "pending",
    skip: null,
    skipReason: null,
    environmentRecovery: null,
    resultSummary: null,
    reproduction: null,
    evidence: [],
    bouncedToPanelId: null,
    recheckRequestedAt: null,
    recheckDispatchId: null,
    recheckWorkerPanelId: null,
    recheckWorkerRole: null,
    recheckOutboxMtimeMs: null,
    recheckAttempt: 0,
  }));
}

function buildReviewCheckpointBranch(runId: string): string {
  const suffix = runId.replace(/^atr_/, "").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `runweave/agt-${suffix}`;
}
