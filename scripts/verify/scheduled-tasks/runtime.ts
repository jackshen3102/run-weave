import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ScheduledRun,
  ScheduledTask,
} from "@runweave/shared/scheduled-tasks";
import { ScheduledTaskRuntime } from "../../../backend/src/scheduled-tasks/runtime";
import type { TerminalSessionManager } from "../../../backend/src/terminal/manager/manager";
import {
  latestOccurrence,
  nextOccurrences,
} from "../../../backend/src/scheduled-tasks/schedule";
import { ScheduledTaskStore } from "../../../backend/src/scheduled-tasks/storage/store";

import { verifyMigrations } from "./migrations";

const selected = readSelectedCase(process.argv.slice(2));
const cases: Record<string, () => Promise<void>> = {
  migrations: verifyMigrations,
  time: verifyTime,
  dedupe: verifyDedupe,
  restart: verifyRestart,
  catchUp: verifyCatchUp,
  catchUpExecution: verifyCatchUpExecution,
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
  for (const [schedule, through, expected] of [
    [
      { kind: "weekdays", timezone: "Asia/Shanghai", localTime: "00:00" },
      "2026-09-27T01:00:00Z",
      "2026-09-24T16:00:00.000Z",
    ],
    [
      { kind: "weekly", timezone: "UTC", localTime: "09:00", weekdays: [1] },
      "2026-09-23T10:00:00Z",
      "2026-09-21T09:00:00.000Z",
    ],
    [
      { kind: "daily", timezone: "America/Los_Angeles", localTime: "02:30" },
      "2026-03-08T12:00:00Z",
      "2026-03-07T10:30:00.000Z",
    ],
    [
      { kind: "daily", timezone: "America/Los_Angeles", localTime: "01:30" },
      "2026-11-01T10:00:00Z",
      "2026-11-01T08:30:00.000Z",
    ],
  ] as const) {
    assert.equal(
      latestOccurrence(
        schedule as ScheduledTask["schedule"],
        new Date(through),
      ),
      expected,
    );
  }
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

async function verifyCatchUp(): Promise<void> {
  await withStore(async (store) => {
    const runtime = new ScheduledTaskRuntime(
      store,
      {
        getProject: () => ({ path: os.tmpdir() }),
      } as unknown as TerminalSessionManager,
      new Map([
        [
          "codex",
          {
            provider: "codex",
            run: async () => {
              throw new Error("materialization must not execute a provider");
            },
          },
        ],
      ]),
      true,
      { timeoutMs: 1000, maxOutputBytes: 1000 },
    );
    const now = new Date("2026-09-23T09:00:00.000Z");
    try {
      for (const [index, delay] of [
        60_000,
        9 * 3600_000,
        86400_000,
        86400_001,
      ].entries()) {
        const at = new Date(now.getTime() - delay).toISOString();
        const task: ScheduledTask = {
          ...taskFixture(),
          schedule: { kind: "once", timezone: "UTC", runAt: at },
          nextRunAt: at,
          misfirePolicy: { mode: "catch-up-latest", maxDelaySeconds: 86400 },
        };
        await store.createTask(
          task,
          task.projectId,
          `boundary-${index}`,
          "hash",
        );
        await runtime["materializeDue"](now);
        const runs = await store.listRuns(task.id);
        assert.equal(runs.length, 1);
        assert.equal(runs[0]?.status, delay > 86400_000 ? "skipped" : "queued");
        assert.equal(runs[0]?.dispatch?.latenessMs, delay);
        assert.equal((await store.getTask(task.id))?.enabled, false);
      }
      const task: ScheduledTask = {
        ...taskFixture(),
        nextRunAt: "2020-01-01T09:00:00.000Z",
        misfirePolicy: { mode: "catch-up-latest", maxDelaySeconds: 86400 },
      };
      await store.createTask(task, task.projectId, "backlog", "hash");
      await runtime["materializeDue"](now);
      await runtime["materializeDue"](now);
      const runs = await store.listRuns(task.id);
      assert.equal(runs.length, 1);
      const run = runs[0]!;
      assert.equal(run.scheduledFor, now.toISOString());
      assert.equal(run.dispatch?.coalescedFrom, task.nextRunAt);
      assert.equal(
        (await store.getTask(task.id))?.nextRunAt,
        "2026-09-24T09:00:00.000Z",
      );
      assert.equal(
        await store.materializeScheduledRun(
          {
            ...run,
            id: crypto.randomUUID(),
            scheduledFor: "2026-09-22T09:00:00.000Z",
          },
          "stale-occurrence",
          "2026-09-24T09:00:00.000Z",
          task.revision,
          task.nextRunAt!,
        ),
        null,
      );
      // Admission is durable: a new runtime must not duplicate or expire queued work.
      const recovered = new ScheduledTaskRuntime(
        store,
        {} as TerminalSessionManager,
        new Map(),
        false,
        { timeoutMs: 1000, maxOutputBytes: 1000 },
      );
      await recovered.initialize();
      assert.equal((await store.getRun(run.id))?.status, "queued");
      await recovered.dispose();
      await runtime["materializeDue"](new Date("2026-09-24T10:00:00.000Z"));
      const busy = (await store.listRuns(task.id)).find(
        (item) => item.id !== run.id,
      )!;
      assert.equal(busy.error?.code, "busy");
      assert.equal(busy.finishedAt, "2026-09-24T10:00:00.000Z");
      const legacy = {
        ...taskFixture(),
        nextRunAt: "2026-09-22T09:00:00.000Z",
      };
      await store.createTask(legacy, legacy.projectId, "legacy", "hash");
      await runtime["materializeDue"](now);
      assert.equal((await store.listRuns(legacy.id))[0]?.error?.code, "missed");
    } finally {
      await runtime.dispose();
    }
  });
}

async function verifyCatchUpExecution(): Promise<void> {
  await withStore(async (store) => {
    const at = new Date(Date.now() - 9 * 3600_000).toISOString();
    const task: ScheduledTask = {
      ...taskFixture(),
      nextRunAt: at,
      schedule: { kind: "once", timezone: "UTC", runAt: at },
      misfirePolicy: { mode: "catch-up-latest", maxDelaySeconds: 86400 },
    };
    await store.createTask(task, task.projectId, "execute-catch-up", "hash");
    let invocations = 0;
    const runtime = new ScheduledTaskRuntime(
      store,
      {
        getProject: () => ({ path: os.tmpdir() }),
      } as unknown as TerminalSessionManager,
      new Map([
        [
          "codex",
          {
            provider: "codex",
            run: async () => {
              invocations += 1;
              return {
                provider: "codex",
                threadId: "controlled-fixture-thread",
                summary: "verified",
                outcome: "succeeded",
                reason: "",
              };
            },
          },
        ],
      ]),
      true,
      { timeoutMs: 1000, maxOutputBytes: 1000 },
    );
    try {
      await runtime.initialize();
      runtime.start();
      const deadline = Date.now() + 5000;
      while (
        (await store.listRuns(task.id))[0]?.status !== "completed" &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const runs = await store.listRuns(task.id);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.status, "completed");
      assert.equal(runs[0]?.dispatch?.catchUp, true);
      await runtime.dispose();
      await store.recoverInterruptedRuns(
        new Date().toISOString(),
        "restarted-fixture",
      );
      assert.equal(
        await store.claimNextRun("restarted-fixture", new Date().toISOString()),
        null,
      );
      assert.equal(invocations, 1);
    } finally {
      await runtime.dispose();
    }
  });
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
    misfirePolicy: { mode: "skip" },
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
      misfirePolicy: task.misfirePolicy,
    },
    trigger,
    scheduledFor: "2026-09-21T00:00:00.000Z",
    dispatch: null,
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
