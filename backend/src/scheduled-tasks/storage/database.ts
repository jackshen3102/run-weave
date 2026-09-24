import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  ScheduledRun,
  ScheduledTask,
  ScheduledTerminalBinding,
} from "@runweave/shared/scheduled-tasks";
import { logger } from "../../logging/index";
import {
  InvalidScheduledRecord,
  parseTask,
  parseRun,
  type StoredRow,
} from "./validation";
import { migrateScheduledTasks } from "./migrations";
import { appendScheduledOutput, readScheduledOutput } from "./output";
import type { ScheduledOutputChunk } from "./worker-protocol";

const UNFINISHED = ["queued", "running", "stopping", "waiting"] as const;

export class ScheduledTaskDatabase {
  private readonly database: Database.Database;
  private readonly invalidRecords = new Set<string>();

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new Database(databasePath);
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("foreign_keys = ON");
    try {
      migrateScheduledTasks(this.database);
      this.database.pragma("journal_mode = WAL");
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  integrity(): boolean {
    return this.database.pragma("quick_check", { simple: true }) === "ok";
  }

  close(): void {
    this.database.close();
  }

  createTask(
    task: ScheduledTask,
    parentProjectId: string,
    idempotencyKey: string,
    requestHash: string,
  ): ScheduledTask {
    return this.database.transaction(() => {
      const existing = this.readIdempotency("create-task", idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw new Error("idempotency_conflict");
        return this.requireTask(existing.resourceId);
      }
      this.insertTask(task, parentProjectId);
      this.insertIdempotency(
        "create-task",
        idempotencyKey,
        requestHash,
        task.id,
        task.createdAt,
      );
      return task;
    })();
  }

  getTask(taskId: string): ScheduledTask | null {
    const row = this.database
      .prepare("SELECT * FROM scheduled_tasks WHERE id = ?")
      .get(taskId) as StoredRow | undefined;
    return row ? parseTask(row) : null;
  }

  listTasks(): ScheduledTask[] {
    return (
      this.database
        .prepare("SELECT * FROM scheduled_tasks ORDER BY rowid DESC")
        .all() as Array<StoredRow>
    ).map((row) => parseTask(row));
  }

  updateTask(
    task: ScheduledTask,
    expectedRevision: number,
    parentProjectId: string,
  ): ScheduledTask {
    const result = this.database
      .prepare(
        `UPDATE scheduled_tasks SET revision = ?, parent_project_id = ?, project_id = ?, name = ?, enabled = ?, next_run_at = ?, deleted_at = ?, payload_json = ? WHERE id = ? AND revision = ?`,
      )
      .run(
        task.revision,
        parentProjectId,
        task.projectId,
        task.name,
        task.enabled ? 1 : 0,
        task.nextRunAt,
        task.deletedAt,
        JSON.stringify(task),
        task.id,
        expectedRevision,
      );
    if (result.changes !== 1) {
      if (!this.getTask(task.id)) throw new Error("scheduled_task_not_found");
      throw new Error("revision_conflict");
    }
    return task;
  }

  listDueTasks(through: string): ScheduledTask[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM scheduled_tasks WHERE enabled = 1 AND deleted_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id`,
        )
        .all(through) as Array<StoredRow>
    ).flatMap((row) => {
      const task = this.readBackground(row, parseTask);
      return task ? [task] : [];
    });
  }

  materializeScheduledRun(
    run: ScheduledRun,
    occurrenceKey: string,
    nextRunAt: string | null,
    taskRevision: number,
    expectedNextRunAt: string,
  ): ScheduledRun | null {
    return this.database.transaction(() => {
      const existing = this.database
        .prepare("SELECT * FROM scheduled_runs WHERE occurrence_key = ?")
        .get(occurrenceKey) as StoredRow | undefined;
      if (existing) return parseRun(existing);
      const task = this.requireTask(run.taskId);
      if (task.revision !== taskRevision) throw new Error("revision_conflict");
      if (
        !task.enabled ||
        task.deletedAt ||
        task.nextRunAt !== expectedNextRunAt
      )
        return null;
      const busy = this.findUnfinished(run.taskId);
      const stored = busy
        ? {
            ...run,
            status: "skipped" as const,
            finishedAt: run.dispatch?.evaluatedAt ?? new Date().toISOString(),
            error: { code: "busy", message: "An earlier run is still active" },
          }
        : run;
      this.insertRun(stored, occurrenceKey);
      const updated = {
        ...task,
        nextRunAt,
        enabled: task.schedule.kind === "once" ? false : task.enabled,
      };
      this.updateTaskRow(updated, this.parentProjectId(run.taskId));
      return stored;
    })();
  }

  createManualRun(
    run: ScheduledRun,
    idempotencyKey: string,
    requestHash: string,
  ): ScheduledRun {
    return this.database.transaction(() => {
      const scope = `manual-run:${run.taskId}`;
      const existing = this.readIdempotency(scope, idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw new Error("idempotency_conflict");
        return this.requireRun(existing.resourceId);
      }
      const busy = this.findUnfinished(run.taskId);
      if (busy) throw new Error(`run_busy:${busy.id}`);
      this.insertRun(run, `manual:${run.id}`);
      this.insertIdempotency(
        scope,
        idempotencyKey,
        requestHash,
        run.id,
        run.scheduledFor,
      );
      return run;
    })();
  }

  getRun(runId: string): ScheduledRun | null {
    const row = this.database
      .prepare("SELECT * FROM scheduled_runs WHERE id = ?")
      .get(runId) as StoredRow | undefined;
    return row ? parseRun(row) : null;
  }

  listRuns(taskId: string): ScheduledRun[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM scheduled_runs WHERE task_id = ? ORDER BY scheduled_for DESC, id DESC",
        )
        .all(taskId) as Array<StoredRow>
    ).map((row) => parseRun(row));
  }

  claimNextRun(ownerId: string, now: string): ScheduledRun | null {
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          "SELECT * FROM scheduled_runs WHERE status = 'queued' ORDER BY created_at, id",
        )
        .iterate() as IterableIterator<StoredRow>;
      let run: ScheduledRun | null = null;
      for (const row of rows) {
        run = this.readBackground(row, parseRun);
        if (run) break;
      }
      // Close the iterator before writing or committing this transaction.
      if (!run) return null;
      const claimed: ScheduledRun = {
        ...run,
        status: "running",
        startedAt: now,
      };
      const changed = this.database
        .prepare(
          "UPDATE scheduled_runs SET status = 'running', owner_id = ?, owner_pid = NULL, payload_json = ? WHERE id = ? AND status = 'queued'",
        )
        .run(ownerId, JSON.stringify(claimed), run.id);
      return changed.changes === 1 ? claimed : null;
    })();
  }

  putRun(run: ScheduledRun): ScheduledRun {
    const terminal = ["completed", "failed", "cancelled", "skipped"].includes(
      run.status,
    );
    const result = terminal
      ? this.database
          .prepare(
            "UPDATE scheduled_runs SET status = ?, owner_id = NULL, owner_pid = NULL, payload_json = ? WHERE id = ?",
          )
          .run(run.status, JSON.stringify(run), run.id)
      : this.database
          .prepare(
            "UPDATE scheduled_runs SET status = ?, payload_json = ? WHERE id = ?",
          )
          .run(run.status, JSON.stringify(run), run.id);
    if (result.changes !== 1) throw new Error("scheduled_run_not_found");
    return run;
  }

  setRunOwnerPid(runId: string, ownerId: string, ownerPid: number): boolean {
    const result = this.database
      .prepare(
        "UPDATE scheduled_runs SET owner_pid = ? WHERE id = ? AND owner_id = ? AND status IN ('running', 'stopping')",
      )
      .run(ownerPid, runId, ownerId);
    if (result.changes !== 1) throw new Error("scheduled_run_not_owned");
    return true;
  }

  recoverInterruptedRuns(now: string, currentOwnerId: string): ScheduledRun[] {
    return this.database.transaction(() => {
      const rows = this.database
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
        const run = this.readBackground(row, parseRun);
        if (!run) return [];
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
          this.putRun(unresolved);
          return [unresolved];
        }
        const recovered: ScheduledRun = {
          ...run,
          status: "failed",
          finishedAt: now,
          recoverable: Boolean(run.threadRef),
          error: {
            code: "interrupted",
            message:
              "Backend stopped before execution completion could be confirmed; the prompt was not replayed",
          },
        };
        this.putRun(recovered);
        return [recovered];
      });
    })();
  }

  requestRunStop(runId: string, now: string): ScheduledRun {
    return this.database.transaction(() => {
      const run = this.requireRun(runId);
      if (run.status === "queued") {
        return this.putRun({
          ...run,
          status: "cancelled",
          finishedAt: now,
          error: { code: "cancelled", message: "Cancelled before execution" },
        });
      }
      if (run.status === "running") {
        return this.putRun({ ...run, status: "stopping" });
      }
      return run;
    })();
  }

  appendOutput(runId: string, text: string, maxBytes: number): boolean {
    return appendScheduledOutput(this.database, runId, text, maxBytes);
  }

  readOutput(
    runId: string,
    offset: number,
    maxBytes: number,
  ): ScheduledOutputChunk {
    return readScheduledOutput(this.database, runId, offset, maxBytes);
  }

  putBinding(runId: string, binding: ScheduledTerminalBinding): ScheduledRun {
    const run = this.requireRun(runId);
    return this.putRun({ ...run, terminalBinding: binding });
  }

  private readBackground<T>(
    row: StoredRow,
    parse: (row: StoredRow) => T,
  ): T | null {
    try {
      const value = parse(row);
      this.invalidRecords.delete(row.id);
      return value;
    } catch (error) {
      if (!(error instanceof InvalidScheduledRecord)) throw error;
      if (!this.invalidRecords.has(row.id)) {
        logger.warn("scheduled-tasks.storage.record.invalid", {
          component: "scheduled-tasks",
          message: "Invalid persisted record skipped; original data retained",
          recordKind: error.kind,
          recordId: row.id,
          field: error.field,
        });
        this.invalidRecords.add(row.id);
      }
      return null;
    }
  }

  private insertTask(task: ScheduledTask, parentProjectId: string): void {
    this.database
      .prepare(
        `INSERT INTO scheduled_tasks(id, revision, parent_project_id, project_id, name, enabled, next_run_at, deleted_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.revision,
        parentProjectId,
        task.projectId,
        task.name,
        task.enabled ? 1 : 0,
        task.nextRunAt,
        task.deletedAt,
        JSON.stringify(task),
      );
  }

  private updateTaskRow(task: ScheduledTask, parentProjectId: string): void {
    this.database
      .prepare(
        `UPDATE scheduled_tasks SET revision = ?, parent_project_id = ?, project_id = ?, name = ?, enabled = ?, next_run_at = ?, deleted_at = ?, payload_json = ? WHERE id = ?`,
      )
      .run(
        task.revision,
        parentProjectId,
        task.projectId,
        task.name,
        task.enabled ? 1 : 0,
        task.nextRunAt,
        task.deletedAt,
        JSON.stringify(task),
        task.id,
      );
  }

  private insertRun(run: ScheduledRun, occurrenceKey: string): void {
    this.database
      .prepare(
        `INSERT INTO scheduled_runs(id, task_id, status, trigger_kind, scheduled_for, occurrence_key, created_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.taskId,
        run.status,
        run.trigger,
        run.scheduledFor,
        occurrenceKey,
        run.scheduledFor,
        JSON.stringify(run),
      );
    this.database
      .prepare(
        "INSERT INTO scheduled_run_output(run_id, content) VALUES (?, '')",
      )
      .run(run.id);
  }

  private findUnfinished(taskId: string): ScheduledRun | null {
    const placeholders = UNFINISHED.map(() => "?").join(",");
    const row = this.database
      .prepare(
        `SELECT * FROM scheduled_runs WHERE task_id = ? AND status IN (${placeholders}) ORDER BY created_at LIMIT 1`,
      )
      .get(taskId, ...UNFINISHED) as StoredRow | undefined;
    return row ? parseRun(row) : null;
  }

  private requireTask(taskId: string): ScheduledTask {
    const task = this.getTask(taskId);
    if (!task) throw new Error("scheduled_task_not_found");
    return task;
  }

  private requireRun(runId: string): ScheduledRun {
    const run = this.getRun(runId);
    if (!run) throw new Error("scheduled_run_not_found");
    return run;
  }

  private parentProjectId(taskId: string): string {
    const row = this.database
      .prepare("SELECT parent_project_id FROM scheduled_tasks WHERE id = ?")
      .get(taskId) as { parent_project_id: string } | undefined;
    if (!row) throw new Error("scheduled_task_not_found");
    return row.parent_project_id;
  }

  private readIdempotency(
    scope: string,
    key: string,
  ): { requestHash: string; resourceId: string } | null {
    const row = this.database
      .prepare(
        "SELECT request_hash, resource_id FROM scheduled_idempotency WHERE scope = ? AND idempotency_key = ?",
      )
      .get(scope, key) as
      | { request_hash: string; resource_id: string }
      | undefined;
    return row
      ? { requestHash: row.request_hash, resourceId: row.resource_id }
      : null;
  }

  private insertIdempotency(
    scope: string,
    key: string,
    requestHash: string,
    resourceId: string,
    now: string,
  ): void {
    this.database
      .prepare(
        "INSERT INTO scheduled_idempotency(scope, idempotency_key, request_hash, resource_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(scope, key, requestHash, resourceId, now);
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
