import { randomUUID } from "node:crypto";
import type { ScheduledRun } from "@runweave/shared/scheduled-tasks";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { logger } from "../logging/index";
import { createScheduledRunRecord } from "./run-record";
import { nextOccurrences } from "./schedule";
import type { ScheduledProviderAdapter } from "./providers/types";
import type { ScheduledTaskStore } from "./storage/store";

const TICK_MS = 5_000;
const LATE_WINDOW_MS = 60_000;

export interface ScheduledTaskRuntimeLimits {
  timeoutMs: number;
  maxOutputBytes: number;
}

export class ScheduledTaskRuntime {
  private readonly ownerId = `scheduled:${process.pid}:${randomUUID()}`;
  private readonly active = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private pass: Promise<void> | null = null;
  private activeExecution: Promise<void> | null = null;
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
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled(
      [this.pass, this.activeExecution].filter(
        (value): value is Promise<void> => Boolean(value),
      ),
    );
  }

  private async runPass(): Promise<void> {
    if (!this.enabled) return;
    await this.recoverAbandonedRuns();
    await this.materializeDue(new Date());
    if (this.activeExecution) return;
    const run = await this.store.claimNextRun(
      this.ownerId,
      new Date().toISOString(),
    );
    if (!run) return;
    this.activeExecution = this.execute(run).finally(() => {
      this.activeExecution = null;
      this.wake();
    });
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
      const scheduledFor = task.nextRunAt;
      if (!scheduledFor) continue;
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
      if (now.getTime() - Date.parse(scheduledFor) > LATE_WINDOW_MS) {
        run.status = "skipped";
        run.finishedAt = now.toISOString();
        run.error = {
          code: "missed",
          message: "The schedule was missed while the Backend was unavailable",
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
      await this.store.materializeScheduledRun(
        run,
        `${task.id}:${task.revision}:${scheduledFor}`,
        nextRunAt,
        task.revision,
      );
    }
  }

  private async execute(initial: ScheduledRun): Promise<void> {
    const controller = new AbortController();
    this.active.set(initial.id, controller);
    let current = initial;
    try {
      const project = this.terminalSessionManager.getProject(
        initial.snapshot.projectId,
      );
      if (!project?.path) throw new Error("context_unavailable");
      const provider = this.providers.get(initial.snapshot.provider);
      if (!provider) throw new Error("provider_unavailable");
      const result = await provider.run({
        runId: initial.id,
        prompt: initial.snapshot.prompt,
        workingDirectory: project.path,
        model: initial.snapshot.model,
        effort: initial.snapshot.effort,
        executionPolicy: initial.snapshot.executionPolicy,
        maxOutputBytes: this.limits.maxOutputBytes,
        maxWallTimeMs: this.limits.timeoutMs,
        signal: controller.signal,
        onSpawn: async (pid) => {
          await this.store.setRunOwnerPid(initial.id, this.ownerId, pid);
        },
        onOutput: (text) =>
          this.store.appendOutput(initial.id, text, this.limits.maxOutputBytes),
        onThread: async (threadId) => {
          const persisted = await this.store.getRun(initial.id);
          current = await this.store.putRun({
            ...(persisted ?? current),
            threadRef: { provider: initial.snapshot.provider, threadId },
          });
        },
      });
      const finishedAt = new Date().toISOString();
      const persisted = (await this.store.getRun(initial.id)) ?? current;
      const cancelled =
        controller.signal.aborted || persisted.status === "stopping";
      current = await this.store.putRun({
        ...persisted,
        status: cancelled
          ? "cancelled"
          : result.outcome === "succeeded"
            ? "completed"
            : "failed",
        ...(cancelled ? {} : { outcome: result.outcome }),
        finishedAt,
        summary: cancelled ? persisted.summary : result.summary || null,
        error: cancelled
          ? { code: "cancelled", message: "The scheduled run was cancelled" }
          : result.outcome === "succeeded"
            ? null
            : {
                code:
                  result.outcome === "blocked" ? "task_blocked" : "task_failed",
                message: result.reason || result.summary,
              },
        threadRef: { provider: result.provider, threadId: result.threadId },
        recoverable: true,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "provider_failed";
      const cancelled =
        controller.signal.aborted || code === "provider_cancelled";
      const persisted = (await this.store.getRun(initial.id)) ?? current;
      current = await this.store.putRun({
        ...persisted,
        status: cancelled ? "cancelled" : "failed",
        finishedAt: new Date().toISOString(),
        recoverable: Boolean(current.threadRef),
        error: {
          code: cancelled ? "cancelled" : code,
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
