import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ScheduledRun,
  ScheduledTask,
} from "@runweave/shared/scheduled-tasks";
import { nextOccurrences } from "../../../backend/src/scheduled-tasks/schedule";
import { ScheduledTaskStore } from "../../../backend/src/scheduled-tasks/storage/store";

const selected = readSelectedCase(process.argv.slice(2));
const cases: Record<string, () => Promise<void>> = {
  time: verifyTime,
  dedupe: verifyDedupe,
  restart: verifyRestart,
};

void main();

async function main(): Promise<void> {
  for (const [name, run] of Object.entries(cases)) {
    if (selected && selected !== name) continue;
    await run();
    process.stdout.write(`scheduled-tasks ${name}: ok\n`);
  }
  if (selected && !cases[selected])
    throw new Error(`unknown case: ${selected}`);
}

async function verifyTime(): Promise<void> {
  assert.deepEqual(
    nextOccurrences(
      { kind: "daily", timezone: "Asia/Shanghai", localTime: "09:00" },
      new Date("2026-09-21T01:30:00.000Z"),
      2,
    ),
    ["2026-09-22T01:00:00.000Z", "2026-09-23T01:00:00.000Z"],
  );
  assert.deepEqual(
    nextOccurrences(
      { kind: "daily", timezone: "America/Los_Angeles", localTime: "02:30" },
      new Date("2026-03-08T00:00:00.000Z"),
      1,
    ),
    ["2026-03-09T09:30:00.000Z"],
  );
  assert.deepEqual(
    nextOccurrences(
      { kind: "daily", timezone: "America/Los_Angeles", localTime: "01:30" },
      new Date("2026-11-01T00:00:00.000Z"),
      1,
    ),
    ["2026-11-01T08:30:00.000Z"],
  );
}

async function verifyDedupe(): Promise<void> {
  await withStore(async (store) => {
    const task = taskFixture();
    const created = await store.createTask(
      task,
      task.projectId,
      "create-key",
      "create-hash",
    );
    assert.equal(
      (
        await store.createTask(
          { ...task, id: crypto.randomUUID() },
          task.projectId,
          "create-key",
          "create-hash",
        )
      ).id,
      created.id,
    );
    await assert.rejects(
      () =>
        store.createTask(
          { ...task, id: crypto.randomUUID() },
          task.projectId,
          "create-key",
          "different",
        ),
      /idempotency_conflict/u,
    );
    const run = runFixture(task, "manual");
    assert.equal(
      (await store.createManualRun(run, "run-key", "run-hash")).id,
      run.id,
    );
    assert.equal(
      (
        await store.createManualRun(
          { ...run, id: crypto.randomUUID() },
          "run-key",
          "run-hash",
        )
      ).id,
      run.id,
    );
    await assert.rejects(
      () =>
        store.createManualRun(
          { ...run, id: crypto.randomUUID() },
          "other-key",
          "run-hash",
        ),
      /run_busy/u,
    );
  });
}

async function verifyRestart(): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "runweave-scheduled-"),
  );
  const databasePath = path.join(directory, "scheduled-tasks.sqlite");
  try {
    let store = await ScheduledTaskStore.create({ databasePath });
    const task = taskFixture();
    await store.createTask(task, task.projectId, "create-key", "create-hash");
    const run = await store.createManualRun(
      runFixture(task, "manual"),
      "run-key",
      "run-hash",
    );
    await store.claimNextRun("fixture-owner", new Date().toISOString());
    await store.setRunOwnerPid(run.id, "fixture-owner", 2_147_483_647);
    await store.dispose();
    store = await ScheduledTaskStore.create({ databasePath });
    const recovered = await store.recoverInterruptedRuns(
      new Date().toISOString(),
      "new-owner",
    );
    assert.equal(recovered[0]?.id, run.id);
    assert.equal(recovered[0]?.status, "failed");
    assert.equal(recovered[0]?.error?.code, "interrupted");
    const liveTask = { ...taskFixture(), id: crypto.randomUUID() };
    await store.createTask(
      liveTask,
      liveTask.projectId,
      "live-create",
      "live-hash",
    );
    const liveRun = await store.createManualRun(
      runFixture(liveTask, "manual"),
      "live-run",
      "live-run-hash",
    );
    await store.claimNextRun("live-owner", new Date().toISOString());
    await store.setRunOwnerPid(liveRun.id, "live-owner", process.pid);
    const unresolved = await store.recoverInterruptedRuns(
      new Date().toISOString(),
      "new-owner",
    );
    assert.equal(
      unresolved.find((item) => item.id === liveRun.id)?.status,
      "waiting",
    );
    assert.equal(
      unresolved.find((item) => item.id === liveRun.id)?.error?.code,
      "owner_unresolved",
    );
    await store.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withStore(
  run: (store: ScheduledTaskStore) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "runweave-scheduled-"),
  );
  const store = await ScheduledTaskStore.create({
    databasePath: path.join(directory, "scheduled-tasks.sqlite"),
  });
  try {
    await run(store);
  } finally {
    await store.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

function taskFixture(): ScheduledTask {
  return {
    id: crypto.randomUUID(),
    revision: 1,
    name: "fixture",
    projectId: "fixture-project",
    provider: "codex",
    prompt: "fixture",
    schedule: { kind: "daily", timezone: "UTC", localTime: "09:00" },
    enabled: true,
    nextRunAt: "2026-09-22T09:00:00.000Z",
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
    deletedAt: null,
  };
}
function runFixture(
  task: ScheduledTask,
  trigger: ScheduledRun["trigger"],
): ScheduledRun {
  return {
    id: crypto.randomUUID(),
    taskId: task.id,
    taskRevision: task.revision,
    snapshot: {
      name: task.name,
      projectId: task.projectId,
      provider: task.provider,
      prompt: task.prompt,
      schedule: task.schedule,
    },
    trigger,
    scheduledFor: "2026-09-21T00:00:00.000Z",
    status: "queued",
    startedAt: null,
    finishedAt: null,
    summary: null,
    error: null,
    artifacts: [],
    outputCursor: "0",
    executionProjectId: task.projectId,
    cwd: os.tmpdir(),
    threadRef: null,
    recoverable: false,
    terminalBinding: null,
  };
}
function readSelectedCase(args: string[]): string | null {
  const index = args.indexOf("--case");
  return index >= 0 ? (args[index + 1] ?? null) : null;
}
