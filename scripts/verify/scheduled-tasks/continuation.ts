import assert from "node:assert/strict";
import type {
  ScheduledRecovery,
  ScheduledRun,
  ScheduledTask,
} from "@runweave/shared/scheduled-tasks";
import { createScheduledRunRecord } from "../../../backend/src/scheduled-tasks/run-record";
import { ScheduledTaskRuntime } from "../../../backend/src/scheduled-tasks/runtime";
import type { ScheduledTaskStore } from "../../../backend/src/scheduled-tasks/storage/store";
import type { TerminalSessionManager } from "../../../backend/src/terminal/manager/manager";

const recovery = {
  action: "wait",
  category: "transient",
  evidence: "fixture HTTP 503",
  nextStep: "查询已有成果后继续剩余步骤",
  notBefore: null,
} as const;
const budget = { timeoutMs: 10_000, maxOutputBytes: 4096 };

export async function verifyContinuation(
  store: ScheduledTaskStore,
  directory: string,
  fixture: () => ScheduledTask,
) {
  const create = async (enabled = true) => {
    const task: ScheduledTask = {
      ...fixture(),
      enabled: false,
      nextRunAt: null,
      ...(enabled ? { continuationPolicy: { mode: "bounded" } } : {}),
    };
    await store.createTask(task, task.projectId, task.id, task.id);
    const run = createScheduledRunRecord(
      task,
      "manual",
      new Date().toISOString(),
      directory,
    );
    await store.createManualRun(run, run.id, run.id);
    return run;
  };
  const finish = (
    run: ScheduledRun,
    at: string,
    action: ScheduledRecovery = recovery,
  ) =>
    store.finishExecution(run.id, "fixture-owner", {
      finishedAt: at,
      activeMs: 25,
      outcome: "blocked",
      summary: "第一步已完成",
      error: { code: "task_blocked", message: action.evidence },
      recovery: action,
    });
  const first = await create();
  const claims = await Promise.all([
    store.claimNextRun("fixture-owner", new Date().toISOString(), budget),
    store.claimNextRun("other-owner", new Date().toISOString(), budget),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  await store.setRunThread(first.id, "fixture-owner", "original-thread");
  await store.appendOutput(first.id, "第一轮输出", 4096);
  let run = await finish(first, new Date().toISOString());
  assert.equal(run.status, "waiting");
  assert.equal(run.finishedAt, null);
  assert.equal(run.outcome, undefined);
  assert.equal(
    (await store.listRecentlyFinishedRuns("2000-01-01T00:00:00Z")).length,
    0,
  );
  const savedWait = JSON.stringify(run.continuation);
  await store.recoverInterruptedRuns(new Date().toISOString(), "new-backend");
  assert.equal(
    JSON.stringify((await store.getRun(run.id))?.continuation),
    savedWait,
  );
  assert.equal(
    await store.claimNextRun("other", new Date().toISOString()),
    null,
  );
  // A repeated HTTP request cannot create another continuation or consume quota.
  const revision = run.revision!;
  await store.continueRun(
    run.id,
    revision,
    "continue-once",
    new Date().toISOString(),
  );
  await store.continueRun(
    run.id,
    revision,
    "continue-once",
    new Date().toISOString(),
  );
  await assert.rejects(
    store.continueRun(
      run.id,
      revision + 1,
      "continue-once",
      new Date().toISOString(),
    ),
    /idempotency_conflict/,
  );
  await store.advanceContinuations(new Date().toISOString());
  run = (await store.claimNextRun("fixture-owner", new Date().toISOString(), {
    timeoutMs: 99_999,
    maxOutputBytes: 99_999,
  }))!;
  assert.equal(run.threadRef?.threadId, "original-thread");
  assert.equal(run.continuation?.count, 1);
  assert.deepEqual(run.executionBudget, budget);
  await assert.rejects(
    store.setRunThread(run.id, "fixture-owner", "wrong-thread"),
    /provider_thread_mismatch/,
  );
  await store.requestRunStop(run.id, new Date().toISOString());
  run = await finish(run, new Date().toISOString());
  assert.equal(run.status, "cancelled");
  assert.equal(run.continuation?.nextAt, null);
  const attempts = await store.listAttempts(run.id);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.summary, "第一步已完成");
  assert.equal(attempts[1]?.error?.code, "cancelled");
  assert.equal(attempts[0]?.outputEnd, attempts[1]?.outputStart);

  // Real worker transactions exercise policy limits and preserve the same run across rounds.
  run = await create();
  let at = new Date().toISOString();
  await store.claimNextRun("fixture-owner", at);
  await store.setRunThread(run.id, "fixture-owner", "bounded-thread");
  for (const delay of [60_000, 300_000, 900_000]) {
    run = await finish(run, at);
    assert.equal(Date.parse(run.continuation!.nextAt!) - Date.parse(at), delay);
    at = run.continuation!.nextAt!;
    await store.advanceContinuations(at);
    run = (await store.claimNextRun("fixture-owner", at))!;
  }
  run = await finish(run, at);
  assert.equal(run.status, "failed");
  assert.equal(run.error?.code, "continuation_limit");
  assert.equal((await store.listAttempts(run.id)).length, 4);

  run = await create();
  await store.claimNextRun("fixture-owner", at);
  await store.setRunThread(run.id, "fixture-owner", "expiry-thread");
  run = await finish(run, at);
  await store.advanceContinuations(run.continuation!.deadline!);
  assert.equal(
    (await store.getRun(run.id))?.error?.code,
    "continuation_expired",
  );

  const legacy = await create(false);
  await store.claimNextRun("fixture-owner", at);
  await store.setRunThread(legacy.id, "fixture-owner", "legacy-thread");
  assert.equal((await finish(legacy, at)).status, "failed");
  assert.equal((await store.listAttempts(legacy.id)).length, 1);

  run = await create();
  await store.claimNextRun("fixture-owner", at);
  await store.setRunThread(run.id, "fixture-owner", "unknown-thread");
  await store.recoverInterruptedRuns(at, "restarted-backend");
  assert.equal((await store.getRun(run.id))?.error?.code, "interrupted");
  assert.equal(
    (await store.listAttempts(run.id))[0]?.error?.code,
    "interrupted",
  );
  assert.equal(await store.claimNextRun("new-owner", at), null);

  for (const category of ["input", "permission", "unknown"] as const) {
    run = await create();
    await store.claimNextRun("fixture-owner", at);
    await store.setRunThread(run.id, "fixture-owner", `manual-${category}`);
    run = await finish(run, at, {
      ...recovery,
      action: "needs-input",
      category,
    });
    assert.equal(run.status, "failed");
    assert.equal(run.continuation?.nextAt, null);
    await assert.rejects(
      store.continueRun(run.id, run.revision!, `manual-${category}`, at),
    );
  }
  run = await create();
  await store.claimNextRun("fixture-owner", at);
  await store.setRunThread(run.id, "fixture-owner", "stop-wait-thread");
  run = await finish(run, at);
  const due = run.continuation!.nextAt!;
  await store.requestRunStop(run.id, at);
  await store.advanceContinuations(due);
  assert.equal((await store.getRun(run.id))?.status, "cancelled");
  assert.equal(await store.claimNextRun("other-owner", due), null);

  // Exercise the production runtime with a controlled provider and persistent worker, not only storage.
  const live = await create();
  let calls = 0;
  const runtime = new ScheduledTaskRuntime(
    store,
    {
      getProject: () => ({ path: directory }),
    } as unknown as TerminalSessionManager,
    new Map([
      [
        "codex",
        {
          provider: "codex",
          run: async (request) => {
            calls++;
            if (calls === 1 || calls === 3)
              assert.equal(request.resumeThreadId, undefined);
            else {
              assert.equal(request.resumeThreadId, "runtime-thread");
              assert(request.prompt.includes("不是用户的新授权"));
              assert(request.maxOutputBytes < budget.maxOutputBytes);
              assert(request.maxWallTimeMs < budget.timeoutMs);
            }
            await request.onThread("runtime-thread");
            await request.onOutput(`round ${calls}\n`);
            if (calls === 3) {
              await new Promise<void>((resolve) => {
                if (request.signal.aborted) resolve();
                else
                  request.signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
              });
              throw new Error("provider_cancelled");
            }
            return {
              provider: "codex",
              threadId: "runtime-thread",
              outcome: calls === 1 ? "blocked" : "succeeded",
              summary: calls === 1 ? "还剩一步" : "两步已完成",
              reason: calls === 1 ? "还有下一步" : "",
              recovery:
                calls === 1
                  ? {
                      ...recovery,
                      action: "continue",
                      category: "remaining-work",
                    }
                  : null,
            };
          },
        },
      ],
    ]),
    true,
    budget,
  );
  try {
    await runtime.initialize();
    runtime.start();
    const until = Date.now() + 10_000;
    while (
      (await store.getRun(live.id))?.status !== "completed" &&
      Date.now() < until
    ) {
      runtime.wake();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal((await store.getRun(live.id))?.status, "completed");
    assert.equal((await store.getRun(live.id))?.continuation?.recovery, null);
    assert.equal(calls, 2);
    assert.equal((await store.listAttempts(live.id)).length, 2);
    const stopping = await create();
    while (calls < 3 && Date.now() < until) {
      runtime.wake();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(calls, 3);
    // A stop written by terminal takeover must also abort the existing provider.
    await store.requestRunStop(stopping.id, new Date().toISOString());
    while (
      (await store.getRun(stopping.id))?.status !== "cancelled" &&
      Date.now() < until
    ) {
      runtime.wake();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal((await store.getRun(stopping.id))?.status, "cancelled");
  } finally {
    await runtime.dispose();
  }
}
