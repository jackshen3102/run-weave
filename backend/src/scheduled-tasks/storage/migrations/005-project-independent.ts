import path from "node:path";
import type Database from "better-sqlite3";
import { parseRun, parseTask, type StoredRow } from "../validation";

export const projectIndependentSql = `
DROP INDEX scheduled_tasks_parent;
ALTER TABLE scheduled_tasks DROP COLUMN parent_project_id;
ALTER TABLE scheduled_tasks DROP COLUMN project_id;
CREATE INDEX scheduled_tasks_quick_origin ON scheduled_tasks(
  json_extract(payload_json, '$.origin.projectId'), json_extract(payload_json, '$.origin.quickInputId')
) WHERE deleted_at IS NULL AND json_extract(payload_json, '$.origin.kind') = 'quick-input';
CREATE TABLE scheduled_context_migration_receipts (
  idempotency_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, payload_json TEXT NOT NULL
);
`;

export function convertProjectRecords(database: Database.Database, prompts: ReadonlyMap<string, string>): void {
  const now = new Date().toISOString();
  for (const row of database.prepare("SELECT * FROM scheduled_tasks").all() as StoredRow[]) {
    const task = JSON.parse(row.payload_json) as Record<string, unknown>;
    moveQuickOrigin(task);
    if (!(task.origin as { kind?: string } | undefined)?.kind) {
      const prompt = prompts.get(row.id);
      if (prompt === undefined) throw new Error("missing reviewed task");
      task.prompt = prompt;
      task.revision = Number(task.revision) + 1;
      task.updatedAt = now;
    }
    delete task.projectId;
    task.enabled = false;
    task.nextRunAt = null;
    database.prepare("UPDATE scheduled_tasks SET revision = ?, enabled = 0, next_run_at = NULL, payload_json = ? WHERE id = ?")
      .run(task.revision, JSON.stringify(task), row.id);
  }
  for (const row of database.prepare("SELECT * FROM scheduled_runs").all() as StoredRow[]) {
    const run = JSON.parse(row.payload_json) as Record<string, unknown>;
    const snapshot = run.snapshot as Record<string, unknown>;
    moveQuickOrigin(snapshot);
    const projectId = typeof run.executionProjectId === "string" ? run.executionProjectId : null;
    run.executionContext = typeof run.cwd === "string" && path.isAbsolute(run.cwd) && projectId
      ? { kind: "project", cwd: run.cwd, projectId }
      : { kind: "unavailable", cwd: null, reason: "legacy-context-unavailable", originalProjectId: projectId };
    delete snapshot.projectId;
    delete run.executionProjectId;
    delete run.cwd;
    database.prepare("UPDATE scheduled_runs SET payload_json = ? WHERE id = ?").run(JSON.stringify(run), row.id);
  }
}

export function validateConvertedRecords(database: Database.Database): void {
  for (const row of database.prepare("SELECT * FROM scheduled_tasks").all() as StoredRow[]) parseTask(row);
  for (const row of database.prepare("SELECT * FROM scheduled_runs").all() as StoredRow[]) parseRun(row);
}

function moveQuickOrigin(config: Record<string, unknown>): void {
  const origin = config.origin as Record<string, unknown> | undefined;
  if (origin?.kind === "quick-input") {
    if (typeof config.projectId !== "string" || !config.projectId) throw new Error("invalid quick origin");
    origin.projectId = config.projectId;
  }
}
