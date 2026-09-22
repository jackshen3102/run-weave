import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  ScheduledRun,
  ScheduledTask,
  ScheduledTerminalBinding,
} from "@runweave/shared/scheduled-tasks";
import { migrateScheduledTasks } from "./migrations";
import type { ScheduledOutputChunk } from "./worker-protocol";

const UNFINISHED = ["queued", "running", "stopping", "waiting"] as const;

export class ScheduledTaskDatabase {
  private readonly database: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("foreign_keys = ON");
    try {
      migrateScheduledTasks(this.database);
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
      .prepare("SELECT payload_json FROM scheduled_tasks WHERE id = ?")
      .get(taskId) as { payload_json: string } | undefined;
    return row ? parseTask(row.payload_json) : null;
  }

  listTasks(): ScheduledTask[] {
    return (
      this.database
        .prepare("SELECT payload_json FROM scheduled_tasks ORDER BY rowid DESC")
        .all() as Array<{ payload_json: string }>
    ).map((row) => parseTask(row.payload_json));
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
          `SELECT payload_json FROM scheduled_tasks WHERE enabled = 1 AND deleted_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id`,
        )
        .all(through) as Array<{ payload_json: string }>
    ).map((row) => parseTask(row.payload_json));
  }

  materializeScheduledRun(
    run: ScheduledRun,
    occurrenceKey: string,
    nextRunAt: string | null,
    taskRevision: number,
  ): ScheduledRun {
    return this.database.transaction(() => {
      const existing = this.database
        .prepare(
          "SELECT payload_json FROM scheduled_runs WHERE occurrence_key = ?",
        )
        .get(occurrenceKey) as { payload_json: string } | undefined;
      if (existing) return parseRun(existing.payload_json);
      const task = this.requireTask(run.taskId);
      if (task.revision !== taskRevision) throw new Error("revision_conflict");
      const busy = this.findUnfinished(run.taskId);
      const stored = busy
        ? {
            ...run,
            status: "skipped" as const,
            finishedAt: run.scheduledFor,
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
      .prepare("SELECT payload_json FROM scheduled_runs WHERE id = ?")
      .get(runId) as { payload_json: string } | undefined;
    return row ? parseRun(row.payload_json) : null;
  }

  listRuns(taskId: string): ScheduledRun[] {
    return (
      this.database
        .prepare(
          "SELECT payload_json FROM scheduled_runs WHERE task_id = ? ORDER BY scheduled_for DESC, id DESC",
        )
        .all(taskId) as Array<{ payload_json: string }>
    ).map((row) => parseRun(row.payload_json));
  }

  claimNextRun(ownerId: string, now: string): ScheduledRun | null {
    return this.database.transaction(() => {
      const row = this.database
        .prepare(
          "SELECT id, payload_json FROM scheduled_runs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1",
        )
        .get() as { id: string; payload_json: string } | undefined;
      if (!row) return null;
      const run = parseRun(row.payload_json);
      const claimed: ScheduledRun = {
        ...run,
        status: "running",
        startedAt: now,
      };
      const changed = this.database
        .prepare(
          "UPDATE scheduled_runs SET status = 'running', owner_id = ?, owner_pid = NULL, payload_json = ? WHERE id = ? AND status = 'queued'",
        )
        .run(ownerId, JSON.stringify(claimed), row.id);
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
          "SELECT payload_json, owner_id, owner_pid FROM scheduled_runs WHERE status IN ('running', 'stopping', 'waiting')",
        )
        .all() as Array<{
        payload_json: string;
        owner_id: string | null;
        owner_pid: number | null;
      }>;
      return rows.flatMap((row) => {
        if (row.owner_id === currentOwnerId) return [];
        const run = parseRun(row.payload_json);
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
    const existing = this.database
      .prepare("SELECT content FROM scheduled_run_output WHERE run_id = ?")
      .get(runId) as { content: string } | undefined;
    if (!this.getRun(runId)) throw new Error("scheduled_run_not_found");
    const content = `${existing?.content ?? ""}${text}`;
    if (Buffer.byteLength(content) > maxBytes) return false;
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO scheduled_run_output(run_id, content) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET content = excluded.content`,
        )
        .run(runId, content);
      const run = this.requireRun(runId);
      const next = {
        ...run,
        outputCursor: String(Buffer.byteLength(content)),
      };
      this.database
        .prepare("UPDATE scheduled_runs SET payload_json = ? WHERE id = ?")
        .run(JSON.stringify(next), runId);
    })();
    return true;
  }

  readOutput(
    runId: string,
    offset: number,
    maxBytes: number,
  ): ScheduledOutputChunk {
    if (!this.getRun(runId)) throw new Error("scheduled_run_not_found");
    const row = this.database
      .prepare("SELECT content FROM scheduled_run_output WHERE run_id = ?")
      .get(runId) as { content: string } | undefined;
    const buffer = Buffer.from(row?.content ?? "", "utf8");
    const safeOffset = Math.min(Math.max(0, offset), buffer.byteLength);
    const end = safeUtf8End(
      buffer,
      Math.min(buffer.byteLength, safeOffset + maxBytes),
    );
    return {
      text: buffer.subarray(safeOffset, end).toString("utf8"),
      nextOffset: end,
      totalBytes: buffer.byteLength,
    };
  }

  putBinding(runId: string, binding: ScheduledTerminalBinding): ScheduledRun {
    const run = this.requireRun(runId);
    return this.putRun({ ...run, terminalBinding: binding });
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
        `SELECT payload_json FROM scheduled_runs WHERE task_id = ? AND status IN (${placeholders}) ORDER BY created_at LIMIT 1`,
      )
      .get(taskId, ...UNFINISHED) as { payload_json: string } | undefined;
    return row ? parseRun(row.payload_json) : null;
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

function parseTask(payload: string): ScheduledTask {
  return JSON.parse(payload) as ScheduledTask;
}

function parseRun(payload: string): ScheduledRun {
  return JSON.parse(payload) as ScheduledRun;
}

function safeUtf8End(buffer: Buffer, proposedEnd: number): number {
  if (proposedEnd >= buffer.byteLength) return buffer.byteLength;
  let lead = proposedEnd;
  while (lead > 0 && (buffer[lead]! & 0xc0) === 0x80) lead -= 1;
  if (lead === proposedEnd) return proposedEnd;
  const byte = buffer[lead]!;
  const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  return lead + width <= proposedEnd ? proposedEnd : lead;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
