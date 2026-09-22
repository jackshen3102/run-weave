import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initialSchemaSql } from "../../../backend/src/scheduled-tasks/storage/migrations/001-initial-schema";
import { ScheduledTaskStore } from "../../../backend/src/scheduled-tasks/storage/store";

const requireBackend = createRequire(
  new URL("../../../backend/package.json", import.meta.url),
);
const Database = requireBackend(
  "better-sqlite3",
) as typeof import("better-sqlite3");

/** Exercise the real SQLite file and worker startup, never the installed database. */
export async function verifyMigrations(): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "runweave-scheduled-migrations-"),
  );
  const stores: ScheduledTaskStore[] = [];
  const open = async (databasePath: string) => {
    const store = await ScheduledTaskStore.create({ databasePath });
    stores.push(store);
    return store;
  };
  try {
    const freshPath = path.join(directory, "fresh.sqlite");
    const concurrent = await Promise.all([open(freshPath), open(freshPath)]);
    await Promise.all(concurrent.map((store) => store.dispose()));
    const fresh = new Database(freshPath);
    assert.equal(fresh.pragma("user_version", { simple: true }), 2);
    assert.equal(
      fresh
        .prepare("SELECT count(*) AS n FROM scheduled_schema_migrations")
        .get().n,
      2,
    );
    fresh.close();

    const legacyPath = path.join(directory, "legacy.sqlite");
    const legacy = seedLegacy(legacyPath);
    const originalTask = legacy
      .prepare("SELECT payload_json FROM scheduled_tasks")
      .get().payload_json;
    const originalRun = legacy
      .prepare("SELECT payload_json FROM scheduled_runs")
      .get().payload_json;
    legacy.close();
    const store = await open(legacyPath);
    const task = await store.getTask("legacy-task");
    const run = await store.getRun("legacy-run");
    assert.deepEqual(task, {
      ...JSON.parse(originalTask),
      misfirePolicy: { mode: "skip" },
    });
    assert.deepEqual(run, {
      ...JSON.parse(originalRun),
      snapshot: {
        ...JSON.parse(originalRun).snapshot,
        misfirePolicy: { mode: "skip" },
      },
      dispatch: null,
    });
    assert.equal(
      (await store.readOutput("legacy-run", 0, 1024)).text,
      "original output",
    );
    await store.dispose();
    const upgraded = new Database(legacyPath);
    const history = upgraded
      .prepare("SELECT * FROM scheduled_schema_migrations ORDER BY version")
      .all();
    assert.equal(history.length, 2);
    assert.equal(
      upgraded.prepare("SELECT request_hash FROM scheduled_idempotency").get()
        .request_hash,
      "original-hash",
    );
    assert.equal(
      upgraded.prepare("SELECT occurrence_key FROM scheduled_runs").get()
        .occurrence_key,
      "original-occurrence",
    );
    upgraded.close();
    await (await open(legacyPath)).dispose();
    const reopened = new Database(legacyPath);
    assert.deepEqual(
      reopened
        .prepare("SELECT * FROM scheduled_schema_migrations ORDER BY version")
        .all(),
      history,
    );
    reopened
      .prepare(
        "UPDATE scheduled_schema_migrations SET checksum = 'tampered' WHERE version = 1",
      )
      .run();
    reopened.close();
    await assert.rejects(
      () => open(legacyPath),
      /scheduled_tasks_schema_history_mismatch/,
    );

    const v1Path = path.join(directory, "v1.sqlite");
    const v1 = seedLegacy(v1Path);
    v1.exec(`CREATE TABLE scheduled_schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    v1.prepare(
      "INSERT INTO scheduled_schema_migrations VALUES (1, 'initial-schema', ?, 'original-date')",
    ).run(createHash("sha256").update(initialSchemaSql).digest("hex"));
    v1.pragma("user_version = 1");
    v1.prepare(
      "UPDATE scheduled_tasks SET payload_json = json_set(payload_json, '$.misfirePolicy', json(?))",
    ).run(JSON.stringify({ mode: "catch-up-latest", maxDelaySeconds: 172800 }));
    v1.close();
    const v1Store = await open(v1Path);
    assert.deepEqual((await v1Store.getTask("legacy-task"))?.misfirePolicy, {
      mode: "catch-up-latest",
      maxDelaySeconds: 172800,
    });
    await v1Store.dispose();
    const v2 = new Database(v1Path);
    assert.equal(v2.pragma("user_version", { simple: true }), 2);
    assert.equal(
      v2
        .prepare(
          "SELECT applied_at FROM scheduled_schema_migrations WHERE version = 1",
        )
        .get().applied_at,
      "original-date",
    );
    v2.close();

    const malformedPath = path.join(directory, "malformed.sqlite");
    const malformed = seedLegacy(malformedPath);
    malformed.exec(
      "UPDATE scheduled_runs SET payload_json = json_remove(payload_json, '$.snapshot')",
    );
    malformed.close();
    await assert.rejects(
      () => open(malformedPath),
      /scheduled_tasks_schema_migration_failed/,
    );

    const rollbackPath = path.join(directory, "rollback.sqlite");
    const failed = seedLegacy(rollbackPath);
    failed.exec(
      "CREATE TRIGGER fail_migration BEFORE UPDATE ON scheduled_runs BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
    );
    failed.close();
    await assert.rejects(
      () => open(rollbackPath),
      /scheduled_tasks_schema_migration_failed/,
    );
    const rolledBack = new Database(rollbackPath);
    assert.equal(rolledBack.pragma("user_version", { simple: true }), 0);
    assert.equal(
      rolledBack.prepare("SELECT payload_json FROM scheduled_tasks").get()
        .payload_json,
      originalTask,
    );
    assert.equal(
      rolledBack.prepare("SELECT payload_json FROM scheduled_runs").get()
        .payload_json,
      originalRun,
    );
    assert.equal(
      rolledBack
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name = 'scheduled_schema_migrations'",
        )
        .get().n,
      0,
    );
    rolledBack.exec("DROP TRIGGER fail_migration");
    rolledBack.close();
    await (await open(rollbackPath)).dispose();

    const futurePath = path.join(directory, "future.sqlite");
    const future = seedLegacy(futurePath);
    future.pragma("user_version = 3");
    future.close();
    await assert.rejects(
      () => open(futurePath),
      /scheduled_tasks_schema_too_new/,
    );
    const untouched = new Database(futurePath);
    assert.equal(untouched.pragma("user_version", { simple: true }), 3);
    assert.equal(
      untouched.prepare("SELECT payload_json FROM scheduled_tasks").get()
        .payload_json,
      originalTask,
    );
    assert.equal(
      untouched
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name = 'scheduled_schema_migrations'",
        )
        .get().n,
      0,
    );
    untouched.close();

    const unknownPath = path.join(directory, "unknown.sqlite");
    const unknown = seedLegacy(unknownPath);
    unknown.exec("ALTER TABLE scheduled_tasks ADD COLUMN unexpected TEXT");
    unknown.close();
    await assert.rejects(
      () => open(unknownPath),
      /scheduled_tasks_schema_legacy_mismatch/,
    );
  } finally {
    await Promise.allSettled(stores.map((store) => store.dispose()));
    await rm(directory, { recursive: true, force: true });
  }
}

function seedLegacy(databasePath: string) {
  const db = new Database(databasePath);
  db.exec(initialSchemaSql);
  const task = {
    id: "legacy-task",
    revision: 3,
    name: "legacy",
    projectId: "project",
    provider: "codex",
    prompt: "original prompt",
    schedule: { kind: "daily", timezone: "Asia/Shanghai", localTime: "00:00" },
    enabled: true,
    nextRunAt: "2026-09-22T16:00:00.000Z",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
    deletedAt: null,
  };
  const run = {
    id: "legacy-run",
    taskId: task.id,
    taskRevision: 3,
    snapshot: {
      name: task.name,
      projectId: task.projectId,
      provider: task.provider,
      prompt: task.prompt,
      schedule: task.schedule,
    },
    trigger: "scheduled",
    scheduledFor: "2026-09-21T16:00:00.000Z",
    status: "skipped",
    startedAt: null,
    finishedAt: "2026-09-21T17:00:00.000Z",
    summary: null,
    error: { code: "missed", message: "original error" },
    artifacts: [],
    outputCursor: "15",
    executionProjectId: "project",
    cwd: "/original",
    threadRef: null,
    recoverable: false,
    terminalBinding: null,
  };
  db.prepare(
    "INSERT INTO scheduled_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    task.id,
    task.revision,
    "project",
    "project",
    task.name,
    1,
    task.nextRunAt,
    null,
    JSON.stringify(task),
  );
  db.prepare(
    "INSERT INTO scheduled_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    run.id,
    task.id,
    run.status,
    run.trigger,
    run.scheduledFor,
    "original-occurrence",
    run.scheduledFor,
    null,
    null,
    JSON.stringify(run),
  );
  db.prepare("INSERT INTO scheduled_run_output VALUES (?, ?)").run(
    run.id,
    "original output",
  );
  db.prepare("INSERT INTO scheduled_idempotency VALUES (?, ?, ?, ?, ?)").run(
    "create-task",
    "original-key",
    "original-hash",
    task.id,
    task.createdAt,
  );
  return db;
}
