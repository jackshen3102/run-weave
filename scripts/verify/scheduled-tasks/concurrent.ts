import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import os from "node:os";
import type { ScheduledRun, ScheduledTask } from "@runweave/shared/scheduled-tasks";
import { ScheduledTaskRuntime } from "../../../backend/src/scheduled-tasks/runtime";
import type { ScheduledTaskStore } from "../../../backend/src/scheduled-tasks/storage/store";
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
