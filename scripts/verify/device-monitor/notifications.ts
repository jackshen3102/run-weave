import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
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
