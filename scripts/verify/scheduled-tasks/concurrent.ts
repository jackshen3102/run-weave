import path from "node:path";
import { ScheduledTaskService } from "../../../backend/src/scheduled-tasks/service";
import { ScheduledTaskError } from "../../../backend/src/scheduled-tasks/errors";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import os from "node:os";
import type { ScheduledRun, ScheduledTask } from "@runweave/shared/scheduled-tasks";
import { ScheduledTaskRuntime } from "../../../backend/src/scheduled-tasks/runtime";
import { ScheduledTaskStore } from "../../../backend/src/scheduled-tasks/storage/store";
import type { TerminalSessionManager } from "../../../backend/src/terminal/manager/manager";

export async function verifyConcurrent(
  store: ScheduledTaskStore,
  taskFixture: () => ScheduledTask,
  runFixture: (task: ScheduledTask, trigger: ScheduledRun["trigger"]) => ScheduledRun,
): Promise<void> {
  const tasks = Array.from({ length: 3 }, () => ({
    ...taskFixture(), id: randomUUID(), enabled: false, nextRunAt: null,
  }));
  for (const task of tasks) {
    await store.createTask(task, task.projectId, task.id, "hash");
    await store.createManualRun(runFixture(task, "manual"), task.id, "hash");
  }
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let active = 0;
  let maximum = 0;
  let started = 0;
  const runtime = new ScheduledTaskRuntime(
    store,
    { getProject: () => ({ path: os.tmpdir() }) } as unknown as TerminalSessionManager,
    new Map([["codex", {
      provider: "codex",
      run: async () => {
        started += 1;
        active += 1;
        maximum = Math.max(maximum, active);
        try {
          await gate;
          return { provider: "codex", threadId: randomUUID(),
            summary: "verified", outcome: "succeeded", reason: "" };
        } finally {
          active -= 1;
        }
      },
    }]]),
    true,
    { maxConcurrentRuns: 2, timeoutMs: 1000, maxOutputBytes: 1000 },
  );
  try {
    await runtime.initialize();
    runtime.start();
    const deadline = Date.now() + 5000;
    while (started < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(started, 2);
    assert.equal(maximum, 2);
    const statuses = await Promise.all(tasks.map(async (task) =>
      (await store.listRuns(task.id))[0]?.status));
    assert.equal(statuses.filter((status) => status === "running").length, 2);
    assert.equal(statuses.filter((status) => status === "queued").length, 1);
    release();
    while (started < 3 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(started, 3);
    assert.equal(maximum, 2);
  } finally {
    release();
    await runtime.dispose();
  }
}

export async function verifyArchive(
  store: ScheduledTaskStore,
  directory: string,
  taskFixture: () => ScheduledTask,
  runFixture: (task: ScheduledTask, trigger: ScheduledRun["trigger"]) => ScheduledRun,
): Promise<void> {
  const task = { ...taskFixture(), enabled: false, nextRunAt: null,
    origin: { kind: "quick-input" as const, quickInputId: crypto.randomUUID(),
      projectName: "archive fixture", worktreeName: null } };
  const queued = await store.createQuickInputRun(task, task.projectId, os.tmpdir(), "archive-1", "archive-1");
  const service = new ScheduledTaskService(store, {} as TerminalSessionManager, { enabled: true, providers: [] });
  for (const status of ["queued", "running", "stopping", "waiting"] as const) {
    await store.putRun({ ...queued, status });
    await assert.rejects(service.archiveQuickInputRun(queued.id),
      (error: unknown) => error instanceof ScheduledTaskError && error.code === "run_not_finished" && error.statusCode === 409);
    assert.equal((await store.getRun(queued.id))?.archivedAt, undefined);
  }
  const finished = await store.putRun({ ...queued, status: "failed", outcome: "blocked",
    finishedAt: new Date().toISOString(), summary: "blocked fixture",
    error: { code: "blocked", message: "fixture cannot finish" } });
  await store.appendOutput(finished.id, "original output", 1000);
  const archived = await service.archiveQuickInputRun(finished.id);
  assert.ok(archived.archivedAt);
  assert.equal(archived.status, "failed");
  assert.equal(archived.outcome, "blocked");
  assert.deepEqual(archived.error, finished.error);
  assert.equal((await service.archiveQuickInputRun(finished.id)).archivedAt, archived.archivedAt);
  // A stale execution/attachment snapshot must never unarchive the record.
  assert.equal((await store.putRun(finished)).archivedAt, archived.archivedAt);
  await store.putBinding(finished.id, { terminalSessionId: "fixture-terminal", panelId: "fixture-panel", attachmentState: "ready" });
  assert.equal((await service.listQuickInputRuns({})).items[0]?.archivedAt, archived.archivedAt);
  const next = await store.createQuickInputRun(task, task.projectId, os.tmpdir(), "archive-2", "archive-2");
  assert.notEqual(next.id, finished.id);
  assert.equal(next.archivedAt, undefined);
  const ordinaryTask = taskFixture();
  await store.createTask(ordinaryTask, ordinaryTask.projectId, ordinaryTask.id, ordinaryTask.id);
  const ordinary = await store.createManualRun(runFixture(ordinaryTask, "manual"), "ordinary", "ordinary");
  await store.putRun({ ...ordinary, status: "completed", finishedAt: new Date().toISOString() });
  await assert.rejects(service.archiveQuickInputRun(ordinary.id),
    (error: unknown) => error instanceof ScheduledTaskError && error.code === "not_quick_input_run" && error.statusCode === 400);
  await assert.rejects(service.archiveQuickInputRun(crypto.randomUUID()),
    (error: unknown) => error instanceof ScheduledTaskError && error.statusCode === 404);
  await store.dispose();
  const reopened = await ScheduledTaskStore.create({ databasePath: path.join(directory, "scheduled-tasks.sqlite") });
  try {
    assert.equal((await reopened.getRun(finished.id))?.archivedAt, archived.archivedAt);
    assert.equal((await reopened.readOutput(finished.id, 0, 1000)).text, "original output");
    assert.equal((await reopened.getRun(next.id))?.archivedAt, undefined);
  } finally { await reopened.dispose(); }
}
