import { stat } from "node:fs/promises";
import { continuationPrompt } from "./continuation";
import { randomUUID } from "node:crypto";
import type { ScheduledRun } from "@runweave/shared/scheduled-tasks";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { logger } from "../logging/index";
import { createScheduledRunRecord } from "./run-record";
import { latestOccurrence, nextOccurrences } from "./schedule";
import type { ScheduledProviderAdapter } from "./providers/types";
import type { ScheduledTaskStore } from "./storage/store";

const TICK_MS = 5_000;
const LATE_WINDOW_MS = 60_000;

export interface ScheduledTaskRuntimeLimits {
  maxConcurrentRuns?: number;
  timeoutMs: number;
  maxOutputBytes: number;
}

export class ScheduledTaskRuntime {
  private readonly ownerId = `scheduled:${process.pid}:${randomUUID()}`;
  private readonly active = new Map<string, AbortController>();
  private readonly executions = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private pass: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly store: ScheduledTaskStore,
    private readonly terminalSessionManager: TerminalSessionManager,
    private readonly providers: Map<string, ScheduledProviderAdapter>,
    private readonly enabled: boolean,
    private readonly limits: ScheduledTaskRuntimeLimits,
  ) {}

  async initialize(): Promise<void> {
    await this.recoverAbandonedRuns();
  }

  start(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => this.wake(), TICK_MS);
    this.timer.unref();
    this.wake();
  }

  wake(): void {
    if (this.disposed || this.pass) return;
    this.pass = this.runPass()
      .catch((error) => {
        logger.warn("scheduled-tasks.runtime.pass.failed", {
          component: "scheduled-tasks",
          message: "Scheduled task runtime pass failed",
          error,
        });
      })
      .finally(() => {
        this.pass = null;
      });
  }

  async stop(runId: string): Promise<ScheduledRun> {
    const result = await this.store.requestRunStop(
      runId,
      new Date().toISOString(),
    );
    if (result.status === "stopping") this.active.get(runId)?.abort();
    return result;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pass;
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled(this.executions.values());
  }

  private async runPass(): Promise<void> {
    if (!this.enabled) return;
    await this.recoverAbandonedRuns();
    // A competing Backend or terminal takeover can persist a stop request.
    for (const [runId, controller] of this.active) {
      if ((await this.store.getRun(runId))?.status === "stopping")
        controller.abort();
    }
    await this.store.advanceContinuations(new Date().toISOString());
    await this.materializeDue(new Date());
    const limit = this.limits.maxConcurrentRuns ?? 4;
    while (!this.disposed && this.executions.size < limit) {
      const run = await this.store.claimNextRun(
        this.ownerId,
        new Date().toISOString(),
        {
          timeoutMs: this.limits.timeoutMs,
          maxOutputBytes: this.limits.maxOutputBytes,
        },
      );
      if (!run) return;
      if (this.disposed) {
        await this.store.finishExecution(run.id, this.ownerId, {
          finishedAt: new Date().toISOString(),
          activeMs: 0,
          summary: null,
          error: { code: "cancelled", message: "Backend 已停止" },
        });
        return;
      }
      const execution = this.execute(run)
        .catch((error) => {
          logger.warn("scheduled-tasks.execution.failed", {
            component: "scheduled-tasks",
            runId: run.id,
            error,
          });
        })
        .finally(() => {
          this.executions.delete(run.id);
          this.wake();
        });
      this.executions.set(run.id, execution);
    }
  }

  private async recoverAbandonedRuns(): Promise<void> {
    await this.store.recoverInterruptedRuns(
      new Date().toISOString(),
      this.ownerId,
    );
  }

  private async materializeDue(now: Date): Promise<void> {
    const due = await this.store.listDueTasks(now.toISOString());
    for (const task of due) {
      try {
        const expectedNextRunAt = task.nextRunAt;
        if (!expectedNextRunAt) continue;
        const policy = task.misfirePolicy;
        const latest =
          policy.mode === "catch-up-latest"
            ? latestOccurrence(task.schedule, now)
            : null;
        const scheduledFor =
          latest && Date.parse(latest) >= Date.parse(expectedNextRunAt)
            ? latest
            : expectedNextRunAt;
        const latenessMs = now.getTime() - Date.parse(scheduledFor);
        const maxDelayMs =
          policy.mode === "catch-up-latest"
            ? policy.maxDelaySeconds * 1000
            : LATE_WINDOW_MS;
        const nextRunAt =
          task.schedule.kind === "once"
            ? null
            : (nextOccurrences(task.schedule, now, 1)[0] ?? null);
        const project = this.terminalSessionManager.getProject(task.projectId);
        const run = createScheduledRunRecord(
          task,
          "scheduled",
          scheduledFor,
          project?.path ?? "",
        );
        run.dispatch = {
          evaluatedAt: now.toISOString(),
          latenessMs,
          catchUp:
            policy.mode === "catch-up-latest" &&
            latenessMs > LATE_WINDOW_MS &&
            latenessMs <= maxDelayMs,
          ...(scheduledFor !== expectedNextRunAt
            ? { coalescedFrom: expectedNextRunAt }
            : {}),
        };
        if (latenessMs > maxDelayMs) {
          run.status = "skipped";
          run.finishedAt = now.toISOString();
          run.error = {
            code: "missed",
            message: "The schedule exceeded its allowed delay and was skipped",
          };
        } else if (!project?.path) {
          run.status = "failed";
          run.finishedAt = now.toISOString();
          run.error = {
            code: "context_unavailable",
            message: "The scheduled project directory is unavailable",
          };
        } else if (!this.providers.has(task.provider)) {
          run.status = "failed";
          run.finishedAt = now.toISOString();
          run.error = {
            code: "provider_unavailable",
            message: `Provider ${task.provider} is unavailable`,
          };
        }
        const stored = await this.store.materializeScheduledRun(
          run,
          `${task.id}:${task.revision}:${scheduledFor}`,
          nextRunAt,
          task.revision,
          expectedNextRunAt,
        );
        if (stored)
          logger.info("scheduled-tasks.dispatch", {
            component: "scheduled-tasks",
            message: "Scheduled task dispatch evaluated",
            taskId: task.id,
            runId: stored.id,
            revision: task.revision,
            scheduledFor,
            evaluatedAt: now.toISOString(),
            latenessMs,
            decision:
              stored.error?.code ??
              (run.dispatch.catchUp ? "catch-up" : "queued"),
          });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.startsWith("scheduled_record_invalid:")
        )
          throw error;
        logger.warn("scheduled-tasks.dispatch.record.invalid", {
          component: "scheduled-tasks",
          message: "Task dispatch blocked by invalid persisted record",
          taskId: task.id,
          error,
        });
      }
    }
  }

  private async execute(initial: ScheduledRun): Promise<void> {
    const controller = new AbortController();
    this.active.set(initial.id, controller);
    const executionStarted = Date.now();
    try {
      const project = this.terminalSessionManager.getProject(
        initial.snapshot.projectId,
      );
      if (
        !project?.path ||
        project.path !== initial.cwd ||
        !(await stat(initial.cwd).catch(() => null))?.isDirectory()
      )
        throw new Error("context_unavailable");
      const provider = this.providers.get(initial.snapshot.provider);
      if (!provider) throw new Error("provider_unavailable");
      const budget = initial.executionBudget ?? this.limits;
      const remainingMs =
        budget.timeoutMs - (initial.continuation?.activeMs ?? 0);
      const remainingBytes =
        budget.maxOutputBytes - Number(initial.outputCursor ?? 0);
      if (remainingMs <= 0) throw new Error("provider_timeout");
      if (remainingBytes <= 0)
        throw new Error("provider_output_limit_exceeded");
      const resuming = Boolean(initial.threadRef && initial.continuation);
      const result = await provider.run({
        runId: initial.id,
        projectId: initial.snapshot.projectId,
        prompt: resuming
          ? continuationPrompt(initial)
          : initial.snapshot.prompt,
        ...(resuming ? { resumeThreadId: initial.threadRef!.threadId } : {}),
        workingDirectory: project.path,
        model: initial.snapshot.model,
        effort: initial.snapshot.effort,
        executionPolicy: initial.snapshot.executionPolicy,
        maxOutputBytes: remainingBytes,
        maxWallTimeMs: remainingMs,
        signal: controller.signal,
        onSpawn: async (pid) => {
          await this.store.setRunOwnerPid(initial.id, this.ownerId, pid);
        },
        onOutput: (text) =>
          this.store.appendOutput(initial.id, text, budget.maxOutputBytes),
        onThread: async (threadId) => {
          await this.store.setRunThread(initial.id, this.ownerId, threadId);
        },
      });
      if (resuming && result.threadId !== initial.threadRef!.threadId)
        throw new Error("provider_thread_mismatch");
      await this.store.setRunThread(initial.id, this.ownerId, result.threadId);
      await this.store.finishExecution(initial.id, this.ownerId, {
        finishedAt: new Date().toISOString(),
        activeMs: Date.now() - executionStarted,
        outcome: result.outcome,
        summary: result.summary || null,
        recovery: result.recovery,
        error: controller.signal.aborted
          ? { code: "cancelled", message: "运行已停止" }
          : result.outcome === "succeeded"
            ? null
            : {
                code:
                  result.outcome === "blocked" ? "task_blocked" : "task_failed",
                message: result.reason || result.summary,
              },
      });
    } catch (error) {
      const code = controller.signal.aborted
        ? "cancelled"
        : error instanceof Error
          ? error.message
          : "provider_failed";
      await this.store.finishExecution(initial.id, this.ownerId, {
        finishedAt: new Date().toISOString(),
        activeMs: Date.now() - executionStarted,
        summary: null,
        error: {
          code: code === "provider_cancelled" ? "cancelled" : code,
          message: providerErrorMessage(code),
        },
      });
    } finally {
      this.active.delete(initial.id);
    }
  }
}

function providerErrorMessage(code: string): string {
  switch (code) {
    case "provider_timeout":
      return "The scheduled run exceeded its time limit";
    case "provider_output_limit_exceeded":
      return "The scheduled run exceeded its output limit";
    case "context_unavailable":
      return "The scheduled project directory is unavailable";
    case "provider_unavailable":
      return "The requested provider is unavailable";
    case "provider_thread_mismatch":
      return "恢复的对话身份不匹配，已停止自动继续。";
    case "provider_thread_missing":
      return "The provider did not return a persistent thread identity";
    case "provider_completion_missing":
      return "The provider exited without a confirmed completion event";
    case "provider_result_invalid":
      return "Agent 未返回有效的任务结果，无法确认成功。请查看输出或打开对话。";
    case "provider_output_persist_failed":
      return "运行输出或对话身份保存失败，已停止执行，请检查存储状态。";
    case "provider_stdin_failed":
      return "无法向 Agent 发送任务，请检查 CLI 启动输出。";
    case "provider_exit_nonzero":
      return "Agent 异常退出，请展开输出检查认证、配置或 CLI 错误。";
    case "execution_policy_unavailable":
      return "当前 Codex 不支持自动审批，请更新 Codex 或选择仅沙箱执行。";
    case "cancelled":
    case "provider_cancelled":
      return "The scheduled run was cancelled";
    default:
      return "The scheduled provider failed";
  }
}
