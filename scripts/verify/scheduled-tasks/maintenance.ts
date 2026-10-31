import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import type {
  ScheduledRun,
  ScheduledTask,
} from "@runweave/shared/scheduled-tasks";
import { ScheduledTaskRuntime } from "../../../backend/src/scheduled-tasks/runtime";
import type { ScheduledTaskStore } from "../../../backend/src/scheduled-tasks/storage/store";
import type { TerminalSessionManager } from "../../../backend/src/terminal/manager/manager";

/** Real SQLite ownership and abortable child processes; no model calls or user data. */
export async function verifyMaintenance(
  store: ScheduledTaskStore,
  taskFixture: () => ScheduledTask,
  runFixture: (
    task: ScheduledTask,
    trigger: ScheduledRun["trigger"],
  ) => ScheduledRun,
): Promise<void> {
  const started: string[] = [];
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
          run: async (request) => {
            const child = spawn(
              process.execPath,
              ["-e", "setInterval(() => {}, 1000)"],
              { stdio: "ignore" },
            );
            await request.onSpawn(child.pid!);
            started.push(request.runId);
            return new Promise((_, reject) => {
              const abort = () => child.kill("SIGTERM");
              request.signal.addEventListener("abort", abort, { once: true });
              if (request.signal.aborted) abort();
              child.on("error", reject);
              child.on("exit", () => {
                request.signal.removeEventListener("abort", abort);
                reject(new Error("provider_cancelled"));
              });
            });
          },
        },
      ],
    ]),
    true,
    { timeoutMs: 30_000, maxOutputBytes: 1000, maxConcurrentRuns: 1 },
  );
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error("maintenance integration timeout");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    const first = { ...taskFixture(), enabled: false },
      second = { ...taskFixture(), enabled: false };
    await store.createTask(first, first.projectId, "maintenance-first", "hash");
    await store.createTask(
      second,
      second.projectId,
      "maintenance-second",
      "hash",
    );
    const run1 = runFixture(first, "manual"),
      run2 = runFixture(second, "manual");
    await store.createManualRun(run1, "maintenance-run1", "hash");
    await runtime.initialize();
    runtime.start();
    await wait(() => started.length === 1);
    const lease = await runtime.maintenance.acquire("fixture-owner");
    assert.deepEqual(
      lease.affectedRuns.map((run) => run.runId),
      [run1.id],
    );
    assert.throws(
      () => runtime.maintenance.renew("other-owner", lease.leaseId),
      /INVALID/,
    );
    await store.createManualRun(run2, "maintenance-run2", "hash");
    await runtime.stop(run1.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    runtime.wake();
    assert.equal(
      started.length,
      1,
      "paused scheduler must not claim the queued second run",
    );
    runtime.maintenance.release("fixture-owner", lease.leaseId);
    await wait(() => started.length === 2);
    const next = await runtime.maintenance.acquire("fixture-next");
    assert.deepEqual(
      next.affectedRuns.map((run) => run.runId),
      [run2.id],
    );
    await runtime.dispose();
    assert.equal((await store.getRun(run2.id))?.error?.code, "cancelled");
  } finally {
    await runtime.dispose();
  }
}
