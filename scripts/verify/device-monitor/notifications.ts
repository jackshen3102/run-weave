import type { ScheduledTask } from "../../../packages/shared/src/scheduled-tasks";
import { ScheduledTaskStore } from "../../../backend/src/scheduled-tasks/storage/store";
import { createScheduledRunRecord } from "../../../backend/src/scheduled-tasks/run-record";
import { ScheduledTaskAlerts } from "../../../backend/src/device-monitor/scheduled-task-alerts";
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { APNsResult } from "../../../packages/push-gateway/src/apns";
import { hash } from "../../../packages/push-gateway/src/auth";
import { GatewayStore } from "../../../packages/push-gateway/src/store";
import { createGateway } from "../../../packages/push-gateway/src/app";
import { close, eventually, fixture, listen, pause } from "./fixture";

/** Real HTTPS API, durable SQLite and an observable provider boundary. */
export async function verifyNotifications() {
  let calls = 0;
  let outcome: APNsResult = { state: "accepted" };
  let block = false;
  let release: (() => void) | undefined;
  const f = await fixture(
    async () => null,
    async (_subscription, message) => {
      calls++;
      assert.equal(message.title, "任务完成");
      assert.equal(message.body, "可以查看执行结果了。");
      assert.equal(message.category, "task.completed");
      if (block)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return outcome;
    },
  );
  try {
    const owner = await f.login();
    const batteryBinding = await f.register(owner);
    const make = (subscriptionId = batteryBinding.subscriptionId) => ({
      subscriptionId,
      eventId: randomUUID(),
      category: "task.completed",
      title: "任务完成",
      body: "可以查看执行结果了。",
      occurredAt: new Date().toISOString(),
    });
    const send = (body: unknown) => f.gatewayRequest("/v1/notifications", body);
    const put = (id: string, body: unknown) =>
      f.gatewayRequest(`/v1/subscriptions/${id}`, body, "PUT");
    assert.equal(
      (await send(make())).status,
      403,
      "battery consent is limited to its category",
    );
    assert.equal(
      (
        await f.gatewayRequest(
          "/v1/notifications",
          make(),
          "POST",
          "wrong-token",
        )
      ).status,
      401,
    );
    assert.equal(
      (await send({ ...make(), subscriptionId: randomUUID() })).status,
      403,
    );

    const subscriptionId = randomUUID();
    const registration = {
      installationId: randomUUID(),
      environment: "sandbox",
      deviceToken: "cd".repeat(48),
      displayName: "Integration Mac",
      version: 1,
      categories: ["task.completed"],
    };
    assert.equal((await put(subscriptionId, registration)).status, 200);
    for (const categories of [
      undefined,
      [],
      ["*"],
      ["task.completed", "task.completed"],
      null,
    ]) {
      assert.equal(
        (await put(randomUUID(), { ...registration, categories })).status,
        400,
      );
    }
    assert.equal(
      (
        await put(subscriptionId, {
          ...registration,
          categories: ["task.failed"],
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await put(subscriptionId, {
          ...registration,
          version: 2,
          categories: ["task.completed", "task.failed"],
        })
      ).status,
      200,
    );
    assert.equal(
      (await put(subscriptionId, registration)).status,
      409,
      "stale version cannot change consent",
    );
    assert.equal(
      (await put(randomUUID(), { ...registration, environment: "production" }))
        .status,
      403,
    );
    const event = make(subscriptionId);
    for (const [patch, status] of [
      [{ category: "task.waiting" }, 403],
      [{ category: "battery.low" }, 403],
      [{ title: " " }, 400],
      [{ body: "中".repeat(2000) }, 413],
      [{ occurredAt: new Date(Date.now() - 301_000).toISOString() }, 422],
      [{ occurredAt: new Date(Date.now() + 60_000).toISOString() }, 422],
      [{ url: "https://example.com" }, 400],
    ] as const)
      assert.equal((await send({ ...event, ...patch })).status, status);
    const foreignToken = randomUUID();
    f.gatewayStore.update((data) => {
      data.senders[hash(foreignToken)] = {
        hostId: randomUUID(),
        environments: ["sandbox"],
      };
    });
    assert.equal(
      (await f.gatewayRequest("/v1/notifications", event, "POST", foreignToken))
        .status,
      403,
    );
    assert.equal(
      (await f.gatewayRequest("/v1/battery-alerts", {})).status,
      404,
    );
    assert.equal(
      (await f.gatewayRequest(`/v1/cycles/${randomUUID()}/complete`, {}))
        .status,
      404,
    );
    assert.equal(calls, 0);
    block = true;
    const pending = send(event);
    await eventually(() => !!release);
    const concurrent = await (await send(event)).json();
    assert.equal(concurrent.state, "unknown");
    assert.match(concurrent.notificationId, /^[0-9a-f]{64}$/);
    release!();
    const accepted = await (await pending).json();
    assert.equal(accepted.state, "accepted");
    assert.deepEqual(await (await send(event)).json(), accepted);
    assert.equal(
      (await send({ ...event, body: "different content" })).status,
      409,
    );
    assert.equal(calls, 1);
    block = false;

    const alias = randomUUID();
    assert.equal((await put(alias, registration)).status, 200);
    assert.deepEqual(
      await (await send({ ...event, subscriptionId: alias })).json(),
      accepted,
    );
    assert.equal(calls, 1, "aliases share target-level identity");
    outcome = { state: "unknown" };
    const uncertain = make(subscriptionId);
    const unknown = await (await send(uncertain)).json();
    assert.equal(unknown.state, "unknown");
    assert.deepEqual(await (await send(uncertain)).json(), unknown);
    assert.equal(calls, 2);

    // Restart a separate fixture copy, then replay via HTTP. Never touch real state.
    const directory = path.join(f.directory, "generic-recovery");
    let recovered = new GatewayStore(directory);
    recovered.update((data) => {
      Object.assign(data, f.gatewayStore.snapshot());
      data.deliveries[unknown.notificationId]!.state = "sending";
      data.senders[hash("recovery-credential")] = {
        hostId: batteryBinding.hostId,
        environments: ["sandbox"],
      };
    });
    recovered.close();
    recovered = new GatewayStore(directory);
    const server = createGateway(recovered, async () => {
      throw new Error("must not resend");
    });
    const port = await listen(server);
    try {
      const response = await fetch(
        `http://localhost:${port}/v1/notifications`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer recovery-credential",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(uncertain),
        },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), unknown);
    } finally {
      await close(server);
      recovered.close();
    }

    outcome = { state: "retry", retryAfterMs: 1 };
    const retry = make(subscriptionId);
    const retryResult = await (await send(retry)).json();
    assert.equal(retryResult.retryAfterMs, 5000);
    assert.equal((await (await send(retry)).json()).state, "retry");
    assert.equal(calls, 3);
    await pause(5050);
    outcome = { state: "accepted" };
    assert.equal((await (await send(retry)).json()).state, "accepted");
    assert.equal(calls, 4);
    assert.equal(
      (await send(make(alias))).status,
      429,
      "aliases cannot evade target rate limit",
    );
    const binding = f.gatewayStore.snapshot().subscriptions[subscriptionId]!;
    assert.equal(
      (
        await f.gatewayRequest(
          `/v1/subscriptions/${subscriptionId}`,
          undefined,
          "DELETE",
          binding.revokeToken,
        )
      ).status,
      204,
    );
    assert.equal((await send(event)).status, 410);
    assert.equal(
      (await put(subscriptionId, { ...registration, version: 3 })).status,
      409,
    );
    assert.equal(calls, 4);
    process.stdout.write(
      "PASS generic HTTPS notifications: explicit required categories, scoped consent, identity/env/host auth, UTF-8 limits, freshness, durable concurrent/alias dedupe, content conflict, restart, retry, rate limit and revocation\n",
    );
  } finally {
    release?.();
    await f.dispose();
  }
}

/** Real subscription registration, scheduled SQLite, HTTPS relay and durable claims. */
export async function verifyScheduledNotifications() {
  let calls = 0;
  let outcome: APNsResult = { state: "accepted" };
  const f = await fixture(async () => null, async () => { calls++; return outcome; });
  let runs: ScheduledTaskStore | undefined;
  let alerts: ScheduledTaskAlerts | undefined;
  try {
    runs = await ScheduledTaskStore.create({ databasePath: path.join(f.directory, "runs.sqlite"), env: {} });
    const installation = randomUUID();
    const register = async (target = installation) => {
      const owner = await f.login();
      const value = await f.subscriptions.register(owner.sessionId, target, {
        connectionId: owner.connectionId, kind: "scheduled-task", enabled: true,
        environment: "sandbox", deviceToken: "ab".repeat(48), displayName: "Fixture",
      });
      await f.subscriptions.confirm(owner.sessionId, target, value!.subscriptionId, value!.version);
      return value!.subscriptionId;
    };
    const aliases = await Promise.all([register(), register(), register()]);
    const otherPhone = await register(randomUUID());
    const now = new Date().toISOString();
    const task: ScheduledTask = {
      id: randomUUID(), revision: 1, name: "background fixture", projectId: "fixture",
      provider: "codex", prompt: "fixture", enabled: false, nextRunAt: null,
      schedule: { kind: "daily", timezone: "UTC", localTime: "09:00" },
      misfirePolicy: { mode: "skip" }, createdAt: now, updatedAt: now, deletedAt: null,
    };
    await runs.createTask(task, task.projectId, task.id, task.id);
    const finish = async (quick = false) => {
      const run = createScheduledRunRecord({ ...task, ...(quick ? { origin: {
        kind: "quick-input" as const, quickInputId: "fixture", projectName: "Fixture", worktreeName: null,
      } } : {}) }, "manual", new Date().toISOString(), f.directory);
      run.status = quick ? "failed" : "completed";
      run.outcome = quick ? "blocked" : "succeeded";
      run.threadRef = { provider: "codex", threadId: randomUUID() };
      run.resultRevision = 1;
      run.finishedAt = new Date().toISOString();
      await runs!.createManualRun(run, run.id, run.id);
      return run;
    };
    const pass = async () => {
      alerts = new ScheduledTaskAlerts(runs!, f.subscriptions);
      alerts.start();
      // Observe the real pass without adding a testing API to the production service.
      await (alerts as unknown as { flight: Promise<void> }).flight;
      await alerts.dispose();
      alerts = undefined;
    };
    const run = await finish(true);
    await pass();
    assert.equal(calls, 2, "three aliases send once; another phone still receives its own alert");
    assert.equal(Object.keys(f.monitorStore.snapshot().taskDeliveries!).length, 2);
    await register();
    await pass();
    assert.equal(calls, 2, "restart and a new connection cannot replay an accepted result");

    // Recreate an old release's subscription-keyed records for this result.
    await f.monitorStore.update((data) => {
      const deliveries = data.taskDeliveries!;
      const original = Object.values(deliveries).find((d) => d.subscriptionId !== otherPhone)!;
      delete deliveries[original.id];
      aliases.forEach((subscriptionId, index) => {
        const id = createHash("sha256").update(`${run.id}:1:${subscriptionId}`).digest("hex");
        deliveries[id] = { ...original, id, subscriptionId,
          state: index === 0 ? "unknown" : "pending", attempts: index === 0 ? 1 : 0 };
      });
      data.subscriptions[aliases[0]!]!.enabled = false;
    });
    await pass();
    assert.equal(calls, 2, "legacy unknown delivery suppresses pending aliases even after logout");
    assert.equal(Object.values(f.monitorStore.snapshot().taskDeliveries!).filter((d) => d.state === "pending").length, 0);

    // A new finished result of the same run must remain independently notifyable.
    await runs.continueRun(run.id, run.revision!, "fixture-continue", new Date().toISOString(), "continue fixture");
    await runs.claimNextRun("fixture-owner", new Date().toISOString());
    await runs.finishExecution(run.id, "fixture-owner", {
      finishedAt: new Date().toISOString(), activeMs: 1, outcome: "succeeded", summary: "second result", error: null,
    });
    await pass();
    assert.equal(calls, 4, "next result revision sends once per phone");

    // Use a new target to keep this independent of the relay's four-per-minute limit.
    for (const s of Object.values(f.monitorStore.snapshot().subscriptions)) await f.subscriptions.disable(s.id);
    await register(randomUUID());
    const retryRun = await finish();
    outcome = { state: "retry", retryAfterMs: 1 };
    await pass();
    const retry = Object.values(f.monitorStore.snapshot().taskDeliveries!).find((d) => d.runId === retryRun.id)!;
    assert.equal(retry.state, "pending");
    const beforeRetry = calls;
    await pass();
    assert.equal(calls, beforeRetry, "retry delay is respected");
    await pause(5050);
    outcome = { state: "accepted" };
    await pass();
    assert.equal(calls, beforeRetry + 1);
    assert.equal(f.monitorStore.snapshot().taskDeliveries![retry.id]!.state, "accepted");
    await pass();
    assert.equal(calls, beforeRetry + 1);
    process.stdout.write("PASS scheduled notifications: three connections/one phone, separate phone, reconnect, restart, legacy unknown/pending migration, result revision, scheduled and quick-input runs, bounded retry\n");
  } finally {
    await alerts?.dispose();
    await runs?.dispose();
    await f.dispose();
  }
}
