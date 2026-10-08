import type { StoredRow } from "./validation";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ScheduledRecovery,
  ScheduledRun,
  ScheduledRunAttempt,
} from "@runweave/shared/scheduled-tasks";
import { scheduledReplyUnavailable } from "@runweave/shared/scheduled-tasks";
import { initialContinuation, scheduleContinuation } from "../continuation";

export interface ScheduledExecutionResult {
  finishedAt: string;
  activeMs: number;
  outcome?: ScheduledRun["outcome"];
  summary: string | null;
  error: ScheduledRun["error"];
  recovery?: ScheduledRecovery | null;
}

/** Borrows the DB. All execution state changes run in the caller's SQLite worker. */
export class ScheduledExecutions {
  constructor(
    private readonly db: Database.Database,
    private readonly get: (id: string) => ScheduledRun,
    private readonly put: (run: ScheduledRun) => ScheduledRun,
    private readonly read: (row: StoredRow) => ScheduledRun | null,
  ) {}

  attempts(runId: string): ScheduledRunAttempt[] {
    return (
      this.db
        .prepare(
          "SELECT payload_json FROM scheduled_run_attempts WHERE run_id = ? ORDER BY sequence",
        )
        .all(runId) as Array<{ payload_json: string }>
    ).map((row) => JSON.parse(row.payload_json));
  }

  claim(
    run: ScheduledRun,
    ownerId: string,
    now: string,
    budget?: ScheduledRun["executionBudget"],
  ): ScheduledRun {
    const attempt: ScheduledRunAttempt = {
      id: randomUUID(),
      runId: run.id,
      sequence: this.attempts(run.id).length + 1,
      ...(run.continuationInput ? { userReply: run.continuationInput } : {}),
      threadId: run.threadRef?.threadId ?? null,
      startedAt: now,
      finishedAt: null,
      outputStart: run.outputCursor ?? "0",
      outputEnd: null,
      outcome: null,
      summary: null,
      error: null,
      recovery: null,
    };
    const continuing = Boolean(run.threadRef && run.continuation);
    if (
      continuing &&
      (run.terminalBinding ||
        (!run.continuationInput &&
          run.continuation!.count >= run.continuation!.maxAttempts))
    )
      throw new Error("thread_busy");
    this.db
      .prepare("INSERT INTO scheduled_run_attempts VALUES (?, ?, ?, ?, ?)")
      .run(
        attempt.id,
        run.id,
        attempt.sequence,
        ownerId,
        JSON.stringify(attempt),
      );
    const claimed = this.put({
      ...run,
      executionBudget: run.executionBudget ?? budget,
      status: "running",
      startedAt: run.startedAt ?? now,
      activeAttemptId: attempt.id,
      recoverable: false,
      ...(run.continuation
        ? {
            continuation: {
              ...run.continuation,
              count:
                run.continuation.count +
                (continuing && !run.continuationInput ? 1 : 0),
              nextAt: null,
            },
          }
        : {}),
    });
    this.db
      .prepare(
        "UPDATE scheduled_runs SET owner_id = ?, owner_pid = NULL WHERE id = ?",
      )
      .run(ownerId, run.id);
    return claimed;
  }

  thread(runId: string, ownerId: string, threadId: string): ScheduledRun {
    return this.db.transaction(() => {
      const run = this.owned(runId, ownerId);
      if (run.threadRef && run.threadRef.threadId !== threadId)
        throw new Error("provider_thread_mismatch");
      return this.put({
        ...run,
        threadRef: { provider: run.snapshot.provider, threadId },
      });
    })();
  }

  finish(
    runId: string,
    ownerId: string,
    result: ScheduledExecutionResult,
  ): ScheduledRun {
    return this.db.transaction(() => {
      const run = this.owned(runId, ownerId);
      const cancelled =
        run.status === "stopping" || result.error?.code === "cancelled";
      const error = cancelled
        ? { code: "cancelled", message: "运行已停止，已完成的操作不会回滚。" }
        : result.error;
      this.closeAttempt(run, {
        ...result,
        error,
        ...(cancelled ? { outcome: undefined } : {}),
      });
      const updated: ScheduledRun = {
        ...run,
        activeAttemptId: null,
        continuationInput: undefined,
        status: cancelled
          ? "cancelled"
          : result.outcome === "succeeded"
            ? "completed"
            : "failed",
        finishedAt: result.finishedAt,
        outcome: cancelled ? undefined : result.outcome,
        summary: result.summary ?? run.summary,
        error,
        recoverable: Boolean(run.threadRef),
        ...(run.continuation
          ? {
              continuation: {
                ...run.continuation,
                activeMs: run.continuation.activeMs + result.activeMs,
                nextAt: null,
              },
            }
          : {}),
      };
      if (
        !cancelled &&
        result.outcome !== "succeeded" &&
        result.outcome &&
        ["task_blocked", "task_failed"].includes(error?.code ?? "")
      ) {
        updated.continuation = scheduleContinuation(
          updated,
          result.recovery,
          result.finishedAt,
        );
        if (
          updated.continuation &&
          run.executionBudget &&
          (updated.continuation.activeMs >= run.executionBudget.timeoutMs ||
            Number(run.outputCursor ?? 0) >= run.executionBudget.maxOutputBytes)
        ) {
          updated.continuation = {
            ...updated.continuation,
            nextAt: null,
            stopReason: "本次运行的累计执行或输出额度已用完，请人工处理。",
          };
        }
        if (updated.continuation?.nextAt) {
          updated.status = "waiting";
          updated.finishedAt = null;
          updated.outcome = undefined;
          updated.error = {
            code: "continuation_wait",
            message: result.error?.message ?? "等待继续",
          };
        } else if (updated.continuation?.stopReason) {
          updated.error = {
            code: "continuation_limit",
            message: updated.continuation.stopReason,
          };
        }
      }
      if (updated.continuation && updated.status === "completed") {
        updated.continuation.recovery = null;
        updated.continuation.stopReason = null;
      }
      if (updated.finishedAt)
        updated.resultRevision = (run.resultRevision ?? 0) + 1;
      return this.put(updated);
    })();
  }

  advance(now: string): void {
    this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id FROM scheduled_runs WHERE status IN ('waiting', 'queued')
        AND json_valid(payload_json) AND json_extract(payload_json, '$.continuation.nextAt') IS NOT NULL`,
        )
        .all() as Array<{ id: string }>;
      for (const { id } of rows) {
        const run = this.get(id);
        const state = run.continuation!;
        if (state.deadline && Date.parse(now) >= Date.parse(state.deadline)) {
          this.put({
            ...run,
            status: "failed",
            finishedAt: now,
            outcome: "blocked",
            resultRevision: (run.resultRevision ?? 0) + 1,
            continuation: {
              ...state,
              nextAt: null,
              stopReason: "自动继续已超过恢复时间窗口，请人工处理。",
            },
            error: {
              code: "continuation_expired",
              message: "自动继续已超过恢复时间窗口，请人工处理。",
            },
          });
        } else if (
          Date.parse(state.nextAt!) <= Date.parse(now) &&
          run.status === "waiting"
        ) {
          this.put({ ...run, status: "queued" });
        }
      }
    })();
  }

  continueNow(
    runId: string,
    revision: number,
    key: string,
    now: string,
    reply?: string,
  ): ScheduledRun {
    return this.db.transaction(() => {
      const scope = `continue-run:${runId}`;
      const hash =
        reply === undefined
          ? String(revision)
          : JSON.stringify([revision, reply]);
      const prior = this.db
        .prepare(
          "SELECT request_hash FROM scheduled_idempotency WHERE scope = ? AND idempotency_key = ?",
        )
        .get(scope, key) as { request_hash: string } | undefined;
      if (prior) {
        if (prior.request_hash !== hash)
          throw new Error("idempotency_conflict");
        return this.get(runId);
      }
      const run = this.get(runId);
      if ((run.revision ?? 0) !== revision)
        throw new Error("revision_conflict");
      if (reply !== undefined) {
        if (!reply.trim() || reply.length > 8000)
          throw new Error("reply_invalid");
        if (scheduledReplyUnavailable(run)) throw new Error("thread_busy");
        const busy = this.db
          .prepare(
            "SELECT id FROM scheduled_runs WHERE task_id = ? AND id <> ? AND status IN ('queued', 'running', 'stopping', 'waiting')",
          )
          .get(run.taskId, run.id);
        if (busy) throw new Error("run_busy");
        if (
          run.continuation?.recovery?.notBefore &&
          Date.parse(now) < Date.parse(run.continuation.recovery.notBefore)
        )
          throw new Error("continuation_not_before");
        const updated = this.put({
          ...run,
          status: "queued",
          finishedAt: null,
          outcome: undefined,
          error: null,
          recoverable: false,
          continuationInput: reply.trim(),
          continuation: {
            ...(run.continuation ?? initialContinuation()),
            nextAt: null,
            stopReason: null,
          },
        });
        this.db
          .prepare("INSERT INTO scheduled_idempotency VALUES (?, ?, ?, ?, ?)")
          .run(scope, key, hash, runId, now);
        return updated;
      }
      if (
        run.status !== "waiting" ||
        !run.continuation?.nextAt ||
        !run.threadRef ||
        run.terminalBinding
      )
        throw new Error("thread_busy");
      if (
        run.continuation.deadline &&
        Date.parse(now) >= Date.parse(run.continuation.deadline)
      )
        throw new Error("continuation_expired");
      if (
        run.continuation.recovery?.notBefore &&
        Date.parse(now) < Date.parse(run.continuation.recovery.notBefore)
      )
        throw new Error("continuation_not_before");
      const updated = this.put({
        ...run,
        continuation: { ...run.continuation, nextAt: now },
      });
      this.db
        .prepare("INSERT INTO scheduled_idempotency VALUES (?, ?, ?, ?, ?)")
        .run(scope, key, hash, runId, now);
      return updated;
    })();
  }

  interrupt(run: ScheduledRun, now: string): void {
    this.closeAttempt(run, {
      finishedAt: now,
      activeMs: 0,
      summary: null,
      error: { code: "interrupted", message: "原执行结果未确认，不自动重放。" },
    });
  }

  recover(now: string, currentOwnerId: string): ScheduledRun[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT * FROM scheduled_runs WHERE status IN ('running', 'stopping', 'waiting')",
        )
        .all() as Array<
        StoredRow & {
          owner_id: string | null;
          owner_pid: number | null;
        }
      >;
      return rows.flatMap((row) => {
        if (row.owner_id === currentOwnerId) return [];
        const run = this.read(row);
        if (!run) return [];
        if (
          run.status === "waiting" &&
          run.continuation?.nextAt &&
          !row.owner_id
        )
          return [];
        if (row.owner_pid && processIsAlive(row.owner_pid)) {
          const unresolved: ScheduledRun = {
            ...run,
            status: "waiting",
            error: {
              code: "owner_unresolved",
              message:
                "The previous execution process is still alive; this task will not be replayed",
            },
          };
          this.put(unresolved);
          return [unresolved];
        }
        this.interrupt(run, now);
        const recovered: ScheduledRun = {
          ...run,
          status: "failed",
          activeAttemptId: null,
          ...(run.continuation
            ? { continuation: { ...run.continuation, nextAt: null } }
            : {}),
          resultRevision: (run.resultRevision ?? 0) + 1,
          finishedAt: now,
          recoverable: Boolean(run.threadRef),
          error: {
            code: "interrupted",
            message:
              "Backend stopped before execution completion could be confirmed; the prompt was not replayed",
          },
        };
        this.put(recovered);
        return [recovered];
      });
    })();
  }

  private closeAttempt(
    run: ScheduledRun,
    result: ScheduledExecutionResult,
  ): void {
    if (!run.activeAttemptId) return;
    const row = this.db
      .prepare(
        "SELECT payload_json FROM scheduled_run_attempts WHERE id = ? AND run_id = ?",
      )
      .get(run.activeAttemptId, run.id) as { payload_json: string } | undefined;
    if (!row) throw new Error("scheduled_attempt_missing");
    const attempt: ScheduledRunAttempt = JSON.parse(row.payload_json);
    if (attempt.finishedAt) throw new Error("scheduled_attempt_finished");
    this.db
      .prepare(
        "UPDATE scheduled_run_attempts SET payload_json = ? WHERE id = ?",
      )
      .run(
        JSON.stringify({
          ...attempt,
          finishedAt: result.finishedAt,
          threadId: run.threadRef?.threadId ?? attempt.threadId,
          outputEnd: run.outputCursor,
          outcome: result.outcome ?? null,
          summary: result.summary,
          error: result.error,
          recovery: result.recovery ?? null,
        }),
        attempt.id,
      );
  }

  private owned(runId: string, ownerId: string): ScheduledRun {
    const owner = this.db
      .prepare("SELECT owner_id FROM scheduled_runs WHERE id = ?")
      .get(runId) as { owner_id: string } | undefined;
    const run = this.get(runId);
    if (
      owner?.owner_id !== ownerId ||
      !["running", "stopping"].includes(run.status)
    )
      throw new Error("scheduled_run_not_owned");
    return run;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
