import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TerminalSessionManager } from "../../../backend/src/terminal/manager/manager";
import { ScheduledTaskMigration } from "../../../backend/src/scheduled-tasks/migration";
import { ScheduledTaskStore } from "../../../backend/src/scheduled-tasks/storage/store";
import { registerScheduledTaskMigrationRoutes, taskContextVersionGate } from "../../../backend/src/routes/scheduled-task-migration";
import type { ScheduledTaskService } from "../../../backend/src/scheduled-tasks/service";
import { SCHEDULED_TASK_PROMPT_MAX_LENGTH, type ScheduledTaskMigrationPreview } from "@runweave/shared/scheduled-tasks";
import type { AddressInfo } from "node:net";
import { initialSchemaSql } from "../../../backend/src/scheduled-tasks/storage/migrations/001-initial-schema";
import { catchUpDataSql } from "../../../backend/src/scheduled-tasks/storage/migrations/002-catch-up-data";
import { continuationSql } from "../../../backend/src/scheduled-tasks/storage/migrations/003-continuation";
import { outputChunksSql } from "../../../backend/src/scheduled-tasks/storage/migrations/004-output-chunks";

const requireBackend = createRequire(new URL("../../../backend/package.json", import.meta.url));
const Database = requireBackend("better-sqlite3") as typeof import("better-sqlite3");
const sourceEnv = { ...process.env, RUNWEAVE_SCHEDULED_TASKS_WORKER_ENTRY: undefined };

/** Real v4 database and explicit migration owner, including private backup and rollback. */
export async function verifyProjectMigration(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "runweave-project-migration-"));
  const file = path.join(directory, "tasks.sqlite");
  const manager = { getProject: () => ({ name: "original project", path: "/original" }) } as unknown as TerminalSessionManager;
  const migration = new ScheduledTaskMigration(file, manager);
  try {
    seed(file);
    await assert.rejects(ScheduledTaskStore.create({ databasePath: file, env: sourceEnv }), /scheduled_tasks_migration_required/);
    const preview = migration.preview();
    assert.equal(preview.state, "migration_required");
    assert.equal(preview.schemaVersion, 4);
    assert.equal(preview.tasks[0]!.originalPrompt, "original prompt");
    assert.ok(preview.tasks[0]!.prompt.startsWith("original prompt\n\n"));
    assert.deepEqual(migration.preview(), preview);
    const input = { expectedDatabaseDigest: preview.databaseDigest,
      tasks: preview.tasks.map(task => ({ id: task.id, expectedRevision: task.revision, prompt: task.prompt })) };
    const reader = new Database(file, { readonly: true });
    try {
      reader.prepare("SELECT count(*) FROM scheduled_tasks").get();
      await assert.rejects(migration.apply(input, "open-reader-key"), error => (error as { code: string }).code === "migration_busy");
    } finally { reader.close(); }
    const busy = new Database(file);
    busy.prepare("UPDATE scheduled_runs SET status='waiting', payload_json=json_set(payload_json, '$.status', 'waiting')").run();
    busy.close();
    const busyPreview = migration.preview();
    await assert.rejects(migration.apply({ ...input, expectedDatabaseDigest: busyPreview.databaseDigest }, "busy-key"), error => (error as { code: string }).code === "migration_busy");
    const reset = new Database(file);
    reset.prepare("UPDATE scheduled_runs SET status='completed', payload_json=json_set(payload_json, '$.status', 'completed')").run();
    reset.close();
    assert.equal(migration.preview().databaseDigest, preview.databaseDigest);
    await assert.rejects(migration.apply({ ...input, expectedDatabaseDigest: "0".repeat(64) }, "conflict-key"), error => (error as { code: string }).code === "migration_conflict");
    const broken = new Database(file);
    broken.exec("CREATE TRIGGER migration_failure BEFORE UPDATE ON scheduled_runs BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    broken.close();
    await assert.rejects(migration.apply(input, "failed-key"), /scheduled_tasks_schema_migration_failed/);
    const rollback = new Database(file);
    assert.equal(rollback.pragma("user_version", { simple: true }), 4);
    assert.equal(rollback.prepare("SELECT revision FROM scheduled_tasks").get().revision, 3);
    rollback.exec("DROP TRIGGER migration_failure");
    rollback.close();
    const receipt = await migration.apply(input, "success-key");
    assert.equal(receipt.restartRequired, true);
    assert.deepEqual(await migration.apply(input, "success-key"), receipt);
    await assert.rejects(migration.apply({ ...input, tasks: [] }, "success-key"), error => (error as { code: string }).code === "idempotency_conflict");
    const store = await ScheduledTaskStore.create({ databasePath: file, env: sourceEnv });
    try {
      const task = await store.getTask("original-task");
      assert.equal(task!.revision, 4);
      assert.equal(task!.enabled, false);
      assert.equal(task!.nextRunAt, null);
      assert.equal(task!.prompt, input.tasks[0]!.prompt);
      assert.equal("projectId" in task!, false);
      const run = await store.getRun("original-run");
      assert.deepEqual(run!.executionContext, { kind: "project", projectId: "original-project", cwd: "/original" });
      assert.equal(run!.threadRef!.threadId, "original-thread");
      assert.equal(run!.summary, "original result");
      assert.equal((await store.readOutput(run!.id, 0, 100)).text, "original output");
      assert.equal((await store.replayCreate("original-hash", "original-key"))!.id, task!.id);
      assert.equal((await store.listDueTasks("2100-01-01T00:00:00Z")).length, 0);
    } finally { await store.dispose(); }
    const restoredFile = path.join(directory, "restored.sqlite");
    await copyFile(receipt.backupPath, restoredFile);
    const restored = new Database(restoredFile, { readonly: true });
    try {
      assert.equal(restored.pragma("user_version", { simple: true }), 4);
      assert.equal(restored.prepare("SELECT enabled FROM scheduled_tasks").get().enabled, 1);
    } finally { restored.close(); }
    await verifyPromptLimits(directory, manager, preview.tasks[0]!.prompt.length - preview.tasks[0]!.originalPrompt.length);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function verifyPromptLimits(directory: string, manager: TerminalSessionManager, noteLength: number): Promise<void> {
  const express = requireBackend("express") as typeof import("express");
  for (const length of [SCHEDULED_TASK_PROMPT_MAX_LENGTH, SCHEDULED_TASK_PROMPT_MAX_LENGTH - noteLength, SCHEDULED_TASK_PROMPT_MAX_LENGTH - noteLength + 1]) {
    const file = path.join(directory, `prompt-${length}.sqlite`);
    const originalPrompt = "x".repeat(length);
    seed(file, originalPrompt);
    const migration = new ScheduledTaskMigration(file, manager);
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    const router = express.Router();
    router.use(taskContextVersionGate);
    registerScheduledTaskMigrationRoutes(router, { migration } as ScheduledTaskService);
    app.use("/api/scheduled-tasks", router);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/scheduled-tasks/migration`;
    const headers = { "Content-Type": "application/json", "X-Runweave-Task-Context-Version": "2", "Idempotency-Key": `prompt-${length}` };
    try {
      const response = await fetch(`${base}/preview`, { method: "POST", headers, body: "{}" });
      assert.equal(response.status, 200);
      const preview = await response.json() as ScheduledTaskMigrationPreview;
      const task = preview.tasks[0]!;
      assert.ok(task.prompt.startsWith(originalPrompt));
      assert.ok(task.prompt.length <= SCHEDULED_TASK_PROMPT_MAX_LENGTH);
      assert.equal(task.promptWarning !== null, length + noteLength > SCHEDULED_TASK_PROMPT_MAX_LENGTH);
      if (task.promptWarning) assert.equal(task.prompt, originalPrompt);
      const applied = await fetch(`${base}/apply`, { method: "POST", headers, body: JSON.stringify({
        expectedDatabaseDigest: preview.databaseDigest,
        tasks: [{ id: task.id, expectedRevision: task.revision, prompt: task.prompt }],
      }) });
      assert.equal(applied.status, 200, await applied.text());
      const store = await ScheduledTaskStore.create({ databasePath: file, env: sourceEnv });
      try {
        const stored = await store.getTask(task.id);
        assert.equal(stored!.prompt, task.prompt);
        assert.equal(stored!.enabled, false);
      } finally { await store.dispose(); }
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      migration.maintenance.dispose();
    }
  }
}

function seed(file: string, prompt = "original prompt"): void {
  const db = new Database(file);
  try {
    db.exec("CREATE TABLE scheduled_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const [index, [name, sql]] of [["initial-schema", initialSchemaSql], ["catch-up-data", catchUpDataSql], ["continuation", continuationSql], ["output-chunks", outputChunksSql]].entries()) {
      db.exec(sql!);
      db.prepare("INSERT INTO scheduled_schema_migrations VALUES (?, ?, ?, ?)").run(index + 1, name, createHash("sha256").update(sql!).digest("hex"), "2026-11-08T00:00:00Z");
    }
    db.pragma("user_version=4");
    const config = { name: "original", projectId: "original-project", provider: "codex", prompt,
      schedule: { kind: "daily", timezone: "UTC", localTime: "09:00" }, misfirePolicy: { mode: "skip" } };
    const task = { ...config, id: "original-task", revision: 3, enabled: true, nextRunAt: "2026-11-10T09:00:00Z", createdAt: "2026-11-08T00:00:00Z", updatedAt: "2026-11-08T00:00:00Z", deletedAt: null };
    const run = { id: "original-run", taskId: task.id, taskRevision: 3, snapshot: config, trigger: "manual", scheduledFor: task.createdAt,
      dispatch: null, status: "completed", startedAt: task.createdAt, finishedAt: task.createdAt, summary: "original result", error: null,
      artifacts: [], outputCursor: "15", executionProjectId: "original-project", cwd: "/original", threadRef: { provider: "codex", threadId: "original-thread" }, recoverable: true, terminalBinding: null };
    db.prepare("INSERT INTO scheduled_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(task.id, 3, config.projectId, config.projectId, task.name, 1, task.nextRunAt, null, JSON.stringify(task));
    db.prepare("INSERT INTO scheduled_runs(id,task_id,status,trigger_kind,scheduled_for,occurrence_key,created_at,payload_json) VALUES (?,?,?,?,?,?,?,?)")
      .run(run.id, task.id, run.status, run.trigger, run.scheduledFor, "original-occurrence", run.scheduledFor, JSON.stringify(run));
    db.prepare("INSERT INTO scheduled_run_output_chunks VALUES (?, ?, ?)").run(run.id, 15, Buffer.from("original output"));
    db.prepare("INSERT INTO scheduled_idempotency VALUES (?, ?, ?, ?, ?)").run("create-task", "original-key", "original-hash", task.id, task.createdAt);
  } finally { db.close(); }
}
