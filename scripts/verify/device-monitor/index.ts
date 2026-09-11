import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseMacBattery } from "../../../packages/shared/src/monitoring/battery";
import { sampleBattery } from "../../../backend/src/device-monitor/sampler";
import { DeviceMonitorService } from "../../../backend/src/device-monitor/service";
import { DeviceMonitorStore } from "../../../backend/src/device-monitor/store";
import { GatewayStore } from "../../../packages/push-gateway/src/store";
import { deliver } from "../../../packages/push-gateway/src/delivery";
import { hash } from "../../../packages/push-gateway/src/auth";
import type { APNsResult } from "../../../packages/push-gateway/src/apns";
import { fixture, eventually, pause } from "./fixture";
import { verifyProvider } from "./provider";
import { verifyCadence } from "./cadence";

const battery = (percent: number, ac = false) =>
  parseMacBattery(
    `Now drawing from '${ac ? "AC" : "Battery"} Power'\n -InternalBattery-0 (id=1) ${percent}%; ${ac ? "not charging" : "discharging"}; 1:30 remaining present: true`,
  );
const evidence: string[] = [];
function pass(name: string) {
  evidence.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

async function monitoring() {
  let calls = 0;
  let sample = battery(38);
  let failure = false;
  const f = await fixture(
    async () => {
      calls++;
      if (failure) throw new Error("Injected sample error");
      return sample;
    },
    async () => ({ state: "accepted" }),
  );
  try {
    const owner = await f.login();
    assert.equal((await f.request("/api/device/status")).status, 401);
    assert.equal(f.monitor.snapshot().sampleStatus, "pending");
    assert.equal(f.monitor.snapshot().battery.percent, null);
    await f.monitor.sample();
    const response = await f.request("/api/device/status", owner.accessToken);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).battery.percent, 38);
    for (let i = 0; i < 8; i++)
      await f.request("/api/device/status", owner.accessToken);
    assert.equal(calls, 1);
    const success = f.monitor.snapshot();
    await pause(25);
    failure = true;
    await f.monitor.sample();
    assert.equal(f.monitor.snapshot().sampleStatus, "error");
    assert.equal(f.monitor.snapshot().observedAt, success.observedAt);
    assert.equal(f.monitor.snapshot().battery.percent, 38);
    assert.ok(f.monitor.snapshot().sampleAgeMs! > success.sampleAgeMs!);
    failure = false;
    sample = battery(0);
    await f.monitor.sample();
    assert.equal(f.monitor.snapshot().battery.percent, 0);
    const modern: Array<{ type: string; snapshot?: { revision: number } }> = [],
      legacy: Array<{ type: string }> = [];
    const socket = f.socket(owner),
      old = f.socket(owner, false);
    socket.on("message", (raw) => modern.push(JSON.parse(String(raw))));
    old.on("message", (raw) => legacy.push(JSON.parse(String(raw))));
    await eventually(
      () =>
        modern.some((m) => m.type === "device-status") && legacy.length >= 2,
    );
    const cursor = f.events.getLatestId();
    await f.monitor.sample();
    await f.monitor.sample();
    await pause(40);
    assert.equal(modern.filter((m) => m.type === "device-status").length, 3);
    assert.equal(legacy.filter((m) => m.type === "device-status").length, 0);
    assert.equal(f.events.getLatestId(), cursor);
    const closed = new Promise<number>((resolve) =>
      socket.once("close", resolve),
    );
    await f.auth.logoutSession(owner.accessToken);
    await f.monitor.sample();
    assert.equal(await closed, 1008);
    assert.equal(
      (await f.request("/api/device/status", owner.accessToken)).status,
      401,
    );
    old.terminate();
    assert.equal(
      (await stat(path.join(f.directory, "monitor/state.json"))).mode & 0o777,
      0o600,
    );
    await assert.rejects(
      DeviceMonitorStore.create(path.join(f.directory, "monitor")),
    );
    const host = f.monitor.snapshot().hostId,
      stream = f.monitor.snapshot().streamId;
    await f.monitor.dispose();
    const restored = new DeviceMonitorService(
      await DeviceMonitorStore.create(path.join(f.directory, "monitor")),
      async () => null,
    );
    assert.equal(restored.snapshot().hostId, host);
    assert.notEqual(restored.snapshot().streamId, stream);
    assert.equal(restored.snapshot().battery.percent, null);
    await restored.sample();
    assert.equal(restored.snapshot().sampleStatus, "unsupported");
    await restored.dispose();
    const file = path.join(f.directory, "monitor/state.json");
    const original = await readFile(file, "utf8");
    await writeFile(
      file,
      original.replace('"schemaVersion":1', '"schemaVersion":999'),
    );
    await assert.rejects(
      DeviceMonitorStore.create(path.join(f.directory, "monitor")),
    );
    assert.ok((await readFile(file, "utf8")).includes('"schemaVersion":999'));
    pass(
      "authenticated snapshots, retained failures, true zero, opt-in WS, session revocation, durable identity, exclusive storage",
    );
  } finally {
    await f.dispose();
  }
}

async function physicalSample() {
  const f = await fixture(sampleBattery, async () => ({ state: "accepted" }));
  try {
    const owner = await f.login();
    await f.monitor.sample();
    const response = await f.request("/api/device/status", owner.accessToken);
    const snapshot = await response.json();
    const reference = parseMacBattery(
      execFileSync("/usr/bin/pmset", ["-g", "batt"], { encoding: "utf8" }),
    );
    assert.deepEqual(snapshot.battery, reference);
    const power = execFileSync(
      "/usr/sbin/ioreg",
      ["-rc", "AppleSmartBattery"],
      { encoding: "utf8" },
    );
    assert.equal(reference.presence, "present");
    assert.equal(
      reference.powerSource === "ac",
      /"ExternalConnected" = Yes/.test(power),
    );
    process.stdout.write(
      `System sample: ${reference.percent}% ${reference.powerSource}/${reference.chargeState}\n`,
    );
    pass(
      "macOS real pmset sampling through authenticated HTTP agrees with pmset and ioreg power source",
    );
  } finally {
    await f.dispose();
  }
}

async function thresholds() {
  let sample = battery(21);
  const sent: Array<{ level: number; notificationId: string; token: string }> =
    [];
  const f = await fixture(
    async () => sample,
    async (s, a) => {
      sent.push({
        level: a.level,
        notificationId: a.notificationId,
        token: s.deviceToken,
      });
      return { state: "accepted" };
    },
  );
  try {
    const owner = await f.login(),
      alias = await f.login();
    const installation = randomUUID();
    await f.register(owner, installation);
    await f.register(alias, installation);
    f.alerts.start();
    async function observe(percent: number, ac = false) {
      sample = battery(percent, ac);
      await f.monitor.sample();
      await pause(120);
    }
    await observe(21);
    assert.equal(sent.length, 0);
    await observe(20);
    await eventually(() => sent.length === 1);
    for (const p of [21, 20, 11]) await observe(p);
    await observe(22, true);
    await observe(19);
    assert.equal(sent.length, 1);
    await observe(10);
    await eventually(() => sent.length === 2);
    await observe(0);
    assert.deepEqual(
      sent.map((a) => a.level),
      [20, 10],
    );
    const refreshed = await f.auth.refreshSession(owner.refreshToken);
    assert.equal(refreshed?.sessionId, owner.sessionId);
    owner.accessToken = refreshed!.accessToken;
    await f.register(owner, installation, false);
    assert.equal(sent.length, 2);
    await observe(25);
    await observe(8);
    await eventually(() => sent.length === 3);
    assert.equal(sent[2]?.level, 10);
    const removed = await f.request(
      `/api/device/notifications/subscriptions/${installation}`,
      owner.accessToken,
      "DELETE",
    );
    assert.equal(removed.status, 204);
    assert.equal(
      Object.values(f.gatewayStore.snapshot().subscriptions).filter(
        (s) => !s.revoked,
      ).length,
      1,
    );
    await observe(25);
    await observe(20);
    await eventually(() => sent.length === 4);
    const aliasRecord = f.subscriptions
      .status(alias.sessionId)
      .subscriptions.find((s) => s.state === "enabled")!;
    const before =
      f.gatewayStore.snapshot().subscriptions[aliasRecord.subscriptionId]!;
    assert.equal(
      (
        await f.gatewayRequest(
          `/v1/subscriptions/${before.id}`,
          undefined,
          "DELETE",
          before.revokeToken,
        )
      ).status,
      204,
    );
    const late = await f.gatewayRequest(
      `/v1/subscriptions/${before.id}`,
      {
        installationId: installation,
        environment: "sandbox",
        deviceToken: before.deviceToken,
        displayName: before.displayName,
        version: before.version + 1,
      },
      "PUT",
    );
    assert.equal(late.status, 409);
    await f.register(alias, installation, false);
    assert.equal(
      f.subscriptions
        .status(alias.sessionId)
        .subscriptions.some((s) => s.state === "enabled"),
      false,
    );
    await f.register(alias, installation, true);
    await pause(120);
    assert.equal(
      sent.length,
      4,
      "explicit re-enable cannot bypass target/cycle dedupe",
    );
    const unauthorized = await f.request(
      `/api/device/notifications/subscriptions/${randomUUID()}`,
      alias.accessToken,
      "PUT",
      {
        connectionId: owner.connectionId,
        deviceToken: "ab",
        environment: "sandbox",
        displayName: "Fixture",
        enabled: true,
        hostId: randomUUID(),
      },
    );
    assert.equal(unauthorized.status, 400);
    assert.equal(
      JSON.stringify(f.subscriptions.status(alias.sessionId)).includes(
        "deviceToken",
      ),
      false,
    );
    pass(
      "20/10 thresholds, 25 recovery, same-host alias dedupe, real auth refresh, revoke tombstone, re-enable dedupe and strict registration",
    );
  } finally {
    await f.dispose();
  }
}

async function gatewayRecovery() {
  let outcome: APNsResult = { state: "accepted" };
  let release: (() => void) | undefined;
  let wait = false,
    calls = 0;
  const f = await fixture(
    async () => battery(18),
    async () => {
      calls++;
      if (wait)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return outcome;
    },
  );
  try {
    const owner = await f.login(),
      installation = randomUUID();
    const s = await f.register(owner, installation);
    const make = () => {
      const cycleId = randomUUID();
      return {
        notificationId: hash(
          `${s.hostId}:${cycleId}:20:${installation}:sandbox`,
        ),
        subscriptionId: s.subscriptionId,
        cycleId,
        level: 20,
        percent: 18,
        observedAt: new Date().toISOString(),
      };
    };
    const first = make();
    wait = true;
    const pending = f.gatewayRequest("/v1/battery-alerts", first);
    await eventually(() => !!release);
    assert.equal(
      (await (await f.gatewayRequest("/v1/battery-alerts", first)).json())
        .state,
      "unknown",
    );
    release!();
    assert.equal((await (await pending).json()).state, "accepted");
    assert.equal(
      (await (await f.gatewayRequest("/v1/battery-alerts", first)).json())
        .state,
      "accepted",
    );
    assert.equal(calls, 1);
    wait = false;
    outcome = { state: "unknown" };
    const uncertain = make();
    await f.gatewayRequest("/v1/battery-alerts", uncertain);
    await f.gatewayRequest("/v1/battery-alerts", uncertain);
    assert.equal(calls, 2);
    assert.equal(
      (
        await f.gatewayRequest("/v1/battery-alerts", {
          ...make(),
          url: "https://example.com",
        })
      ).status,
      400,
    );
    const foreign = randomUUID();
    assert.equal(
      (
        await f.gatewayRequest("/v1/battery-alerts", {
          ...make(),
          subscriptionId: foreign,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.gatewayRequest(
          `/v1/subscriptions/${s.subscriptionId}`,
          undefined,
          "DELETE",
          "unrelated-revoke-token",
        )
      ).status,
      403,
    );
    await assert.rejects(
      async () => new GatewayStore(path.join(f.directory, "gateway")),
    );
    const old = f.gatewayStore.snapshot();
    // Crash-state recovery uses a separate owned store; it must never re-send a durable sending claim.
    const recovery = path.join(f.directory, "recovery");
    let restored = new GatewayStore(recovery);
    restored.update((data) => {
      Object.assign(data, old);
      data.deliveries[uncertain.notificationId]!.state = "sending";
    });
    restored.close();
    restored = new GatewayStore(recovery);
    assert.equal(
      restored.snapshot().deliveries[uncertain.notificationId]?.state,
      "unknown",
    );
    const sender = Object.values(restored.snapshot().senders)[0]!;
    assert.equal(
      (
        await deliver(restored, sender, first, async () => {
          throw new Error("must not resend");
        })
      ).state,
      "accepted",
    );
    restored.close();
    pass(
      "HTTPS gateway durable claim, concurrent dedupe, ambiguous outcome, strict template, revoke ownership and restart recovery",
    );
  } finally {
    await f.dispose();
  }
}

async function tokenRotationAndRetry() {
  let sample = battery(18),
    release: ((result: APNsResult) => void) | undefined;
  let calls = 0;
  const f = await fixture(
    async () => sample,
    async () => {
      calls++;
      return await new Promise<APNsResult>((resolve) => {
        release = resolve;
      });
    },
  );
  try {
    const owner = await f.login(),
      installation = randomUUID();
    const s = await f.register(owner, installation);
    f.alerts.start();
    await f.monitor.sample();
    await eventually(() => !!release);
    await f.register(owner, installation, false, "cd".repeat(96));
    release!({ state: "failed", invalidToken: true });
    await eventually(() =>
      Object.values(f.monitorStore.snapshot().deliveries).some(
        (d) => d.state === "failed",
      ),
    );
    assert.equal(
      f.gatewayStore.snapshot().subscriptions[s.subscriptionId]?.invalidToken,
      undefined,
    );
    sample = battery(25);
    await f.monitor.sample();
    await pause(80);
    sample = battery(18);
    release = undefined;
    await f.monitor.sample();
    await eventually(() => !!release);
    release!({ state: "retry", retryAfterMs: 6000 });
    await eventually(() =>
      Object.values(f.monitorStore.snapshot().deliveries).some(
        (d) => d.state === "pending",
      ),
    );
    const pending = Object.values(f.monitorStore.snapshot().deliveries).find(
      (d) => d.state === "pending",
    )!;
    assert.ok(pending.nextAttemptAt - Date.now() > 5000);
    sample = battery(18, true);
    await f.monitor.sample();
    await eventually(
      () =>
        f.monitorStore.snapshot().deliveries[pending.id]?.state === "cancelled",
    );
    assert.equal(calls, 2);
    pass(
      "late old-token invalidation retains new token; Retry-After persisted and AC cancels pending retry",
    );
  } finally {
    release?.({ state: "unknown" });
    await f.dispose();
  }
}

async function confirmationBoundary() {
  let sent = 0;
  let sample = battery(18);
  const f = await fixture(
    async () => sample,
    async () => {
      sent++;
      return { state: "accepted" };
    },
  );
  try {
    const owner = await f.login(),
      installation = randomUUID();
    const response = await f.request(
      `/api/device/notifications/subscriptions/${installation}`,
      owner.accessToken,
      "PUT",
      {
        connectionId: owner.connectionId,
        deviceToken: "ef".repeat(48),
        environment: "sandbox",
        displayName: "Pending phone",
        enabled: true,
        explicitEnable: true,
      },
    );
    assert.equal(response.status, 200);
    const registration = await response.json();
    assert.equal(registration.state, "pending");
    assert.ok(registration.revokeToken);
    f.alerts.start();
    await f.monitor.sample();
    await pause(120);
    assert.equal(sent, 0, "unconfirmed phone must not receive alerts");
    const stale = await f.request(
      `/api/device/notifications/subscriptions/${installation}/confirm`,
      owner.accessToken,
      "POST",
      {
        subscriptionId: registration.subscriptionId,
        version: registration.version + 1,
      },
    );
    assert.equal(stale.status, 409);
    assert.equal(sent, 0);
    const confirmed = await f.request(
      `/api/device/notifications/subscriptions/${installation}/confirm`,
      owner.accessToken,
      "POST",
      {
        subscriptionId: registration.subscriptionId,
        version: registration.version,
      },
    );
    assert.equal(confirmed.status, 200);
    await eventually(() => sent === 1);
    await f.auth.logoutSession(owner.accessToken);
    sample = battery(10);
    await f.monitor.sample();
    await pause(120);
    assert.equal(sent, 1);
    assert.equal(
      f.monitorStore.snapshot().subscriptions[registration.subscriptionId]
        ?.enabled,
      false,
    );
    pass(
      "durable revocation confirmation required before alerting; stale confirm rejected and revoked session cannot send next level",
    );
  } finally {
    await f.dispose();
  }
}

async function main() {
  if (process.argv.includes("--cadence")) {
    await verifyCadence();
    return;
  }
  await verifyProvider();
  await physicalSample();
  await monitoring();
  await thresholds();
  await confirmationBoundary();
  await gatewayRecovery();
  await tokenRotationAndRetry();
  process.stdout.write(
    `Integration checks complete: ${evidence.length} groups. APNs transport was recorded, not sent to Apple.\n`,
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
