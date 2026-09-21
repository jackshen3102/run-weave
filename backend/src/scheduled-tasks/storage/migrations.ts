import type Database from "better-sqlite3";

export function migrateScheduledTasks(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      parent_project_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      next_run_at TEXT,
      deleted_at TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scheduled_tasks_due
      ON scheduled_tasks(enabled, next_run_at) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS scheduled_tasks_parent
      ON scheduled_tasks(parent_project_id, deleted_at, name);

    CREATE TABLE IF NOT EXISTS scheduled_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES scheduled_tasks(id),
      status TEXT NOT NULL,
      trigger_kind TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      occurrence_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      owner_id TEXT,
      owner_pid INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scheduled_runs_task
      ON scheduled_runs(task_id, scheduled_for DESC, id DESC);
    CREATE INDEX IF NOT EXISTS scheduled_runs_queue
      ON scheduled_runs(status, created_at, id);

    CREATE TABLE IF NOT EXISTS scheduled_run_output (
      run_id TEXT PRIMARY KEY REFERENCES scheduled_runs(id) ON DELETE CASCADE,
      content TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS scheduled_idempotency (
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(scope, idempotency_key)
    );
  `);
}
