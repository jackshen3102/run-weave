// Isolated HTTP/lifecycle acceptance fixtures, not unit tests. No user process is signalled.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ResourceMonitorStore } from "../../../backend/src/resource-monitor/store";
import {
  createResourceSampler,
  readIdentity,
} from "../../../backend/src/resource-monitor/sampler";
import { ResourceCounters } from "../../../backend/src/resource-monitor/counters";
import { signedBatteryCurrent } from "../../../packages/shared/src/monitoring/battery";
import {
  repositoryRoot,
  pause,
  checks,
  baseSample,
  run,
  window,
} from "./fixtures.mts";

await run(
  "six successful samples over five minutes, boundary, stable episode",
  async (f) => {
    await window(f, 99);
    assert.equal(f.monitor.snapshot(true).alerts.length, 0);
    await f.request("/settings", "PUT", {
      expectedRevision: 0,
      monitorEnabled: false,
      alertsEnabled: true,
    });
    await f.request("/settings", "PUT", {
      expectedRevision: 1,
      monitorEnabled: true,
      alertsEnabled: true,
    });
    await pause(30);
    const start = Date.now();
    for (let i = 0; i < 5; i++) {
      f.next = baseSample();
      f.next.snapshot.sampledAt = start + i * 60000;
      await f.monitor.sample();
      assert.equal(f.monitor.snapshot(true).alerts.length, 0);
    }
    f.next.snapshot.sampledAt = start + 300000;
    await f.monitor.sample();
    const alert = f.monitor.snapshot(true).alerts[0]!;
    assert.equal(alert.sampleCount, 6);
    assert.equal(alert.lastAt - alert.firstAt, 300000);
    f.next.snapshot.sampledAt += 60000;
    await f.monitor.sample();
    assert.equal(f.monitor.snapshot(true).alerts[0]!.alertId, alert.alertId);
  },
);
await run(
  "partial, error and instance replacement reset observation",
  async (f) => {
    const start = Date.now();
    for (let i = 0; i < 5; i++) {
      f.next = baseSample();
      f.next.snapshot.sampledAt = start + i * 60000;
      await f.monitor.sample();
    }
    f.next.snapshot.sampledAt = start + 300000;
    f.next.snapshot.apps[0]!.coverage = "partial";
    await f.monitor.sample();
    assert.equal(f.monitor.snapshot(true).alerts.length, 0);
    await window(f, 100, start + 360000);
    assert.equal(f.monitor.snapshot(true).alerts.length, 1);
    f.next.snapshot.sampledAt += 60000;
    f.next.snapshot.processes[0]!.processInstanceId = "new-instance";
    await f.monitor.sample();
    assert.equal(f.monitor.snapshot(true).alerts.length, 0);
    assert.equal(f.monitor.store.snapshot().alerts[0]!.active, true);
  },
);
await run(
  "AC suspends energy only; memory wording and threshold are independent",
  async (f) => {
    const start = Date.now();
    for (let i = 0; i < 6; i++) {
      f.next = baseSample();
      f.next.snapshot.sampledAt = start + i * 60000;
      f.next.snapshot.battery = {
        available: true,
        percent: 70,
        charging: true,
        powerSource: "ac",
        dischargeRateMa: 0,
        dischargePowerW: null,
        timeRemainingMin: null,
      };
      f.next.snapshot.apps[0]!.memoryMb = 4096;
      await f.monitor.sample();
    }
    const alerts = f.monitor.snapshot(true).alerts;
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.ruleId, "memory");
  },
);
await run("recovery hysteresis and 30 minute cooldown", async (f) => {
  const start = Date.now();
  await window(f, 100, start);
  let at = start + 360000;
  for (const value of [79, 79, 85, 79, 79]) {
    f.next.snapshot.sampledAt = at;
    at += 60000;
    f.next.snapshot.apps[0]!.energyImpact = value;
    await f.monitor.sample();
    assert.equal(f.monitor.store.snapshot().alerts[0]!.active, true);
  }
  f.next.snapshot.sampledAt = at;
  f.next.snapshot.apps[0]!.energyImpact = 79;
  await f.monitor.sample();
  assert.equal(f.monitor.store.snapshot().alerts[0]!.active, false);
  await window(f, 100, at + 60000);
  assert.equal(f.monitor.snapshot(true).alerts.length, 0);
  await window(f, 100, start + 2100000);
  assert.equal(f.monitor.snapshot(true).alerts.length, 1);
  assert.equal(f.monitor.store.snapshot().alerts.length, 2);
});
await run(
  "authenticated cache reads have no sampling side effect; settings strict revision",
  async (f) => {
    await f.monitor.sample();
    const responses = await Promise.all(
      Array.from({ length: 15 }, () => f.request()),
    );
    assert(
      responses.every(
        (r) => r.ok && r.headers.get("cache-control") === "no-store",
      ),
    );
    assert.equal(f.calls, 1);
    const bad = await f.request("/settings", "PUT", {
      expectedRevision: 0,
      monitorEnabled: true,
      alertsEnabled: true,
      threshold: 4,
    });
    assert.equal(bad.status, 400);
    assert.equal(
      (
        await f.request("/settings", "PUT", {
          expectedRevision: 0,
          monitorEnabled: false,
          alertsEnabled: true,
        })
      ).status,
      200,
    );
    await f.monitor.sample();
    assert.equal(f.calls, 1);
    assert.equal(f.device.snapshot().sampleStatus, "ok");
    assert.equal(
      (
        await f.request("/settings", "PUT", {
          expectedRevision: 0,
          monitorEnabled: true,
          alertsEnabled: true,
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.request("", "GET", undefined, { Authorization: "" })).status,
      401,
    );
    await f.auth.logoutSession(f.login.accessToken);
    assert.equal((await f.request()).status, 401);
  },
);
await run("snooze persists and invalid event cannot cross host", async (f) => {
  await window(f, 100);
  const alert = f.monitor.snapshot(true).alerts[0]!;
  assert.equal(
    (
      await f.request(`/alerts/${randomUUID()}/snooze`, "POST", {
        durationMinutes: 60,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request(`/alerts/${alert.alertId}/snooze`, "POST", {
        durationMinutes: 60,
      })
    ).status,
    200,
  );
  assert.equal(f.monitor.snapshot(true).alerts.length, 0);
  assert(f.monitor.store.snapshot().snoozes[alert.appKey]! > Date.now());
  assert.equal(
    (await stat(path.join(f.directory, "resources/state.json"))).mode & 0o777,
    0o600,
  );
});
await run(
  "process API rejects protected, unknown, remote, forged arguments",
  async (f) => {
    const identity = (await readIdentity(
      process.pid,
      AbortSignal.timeout(5000),
    ))!;
    identity.actionKind = "readonly";
    identity.actionReason = "Runweave 控制进程";
    f.next.identities.set(identity.processInstanceId, identity);
    await f.monitor.sample();
    const body = { requestId: randomUUID(), force: false };
    const route = `/processes/${identity.processInstanceId}/terminate`;
    assert.equal((await f.request(route, "POST", body)).status, 403);
    assert.equal(
      (
        await f.request(route, "POST", body, {
          "X-Forwarded-For": "203.0.113.1",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(route, "POST", {
          ...body,
          pid: process.pid,
          signal: "SIGKILL",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request(`/processes/${randomUUID()}/terminate`, "POST", {
          requestId: randomUUID(),
          force: false,
        })
      ).status,
      404,
    );
    assert.equal(
      (await f.request(route, "POST", body, { Authorization: "" })).status,
      401,
    );
    const remote = await (
      await f.request("", "GET", undefined, {
        "X-Forwarded-For": "203.0.113.1",
      })
    ).json();
    assert.equal(remote.canTerminate, false);
  },
);
await run(
  "remote permission defaults off, local-only grant, revocation invalidates force and persists",
  async (f) => {
    const remote = { "X-Forwarded-For": "203.0.113.1" };
    assert.equal(f.monitor.store.snapshot().remoteControl.enabled, false);
    assert.equal(
      (
        await f.request(
          "/remote-control",
          "PUT",
          { expectedRevision: 0, enabled: true },
          remote,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(
          "/settings",
          "PUT",
          {
            expectedRevision: 0,
            monitorEnabled: true,
            alertsEnabled: true,
            remoteControlEnabled: true,
          },
          remote,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request("/remote-control", "PUT", {
          expectedRevision: 0,
          enabled: true,
          extra: true,
        })
      ).status,
      400,
    );
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { stdio: "ignore" },
    );
    try {
      await pause(150);
      const identity = (await readIdentity(
        child.pid!,
        AbortSignal.timeout(5000),
      ))!;
      identity.actionKind = "terminate";
      f.next.identities.set(identity.processInstanceId, identity);
      await f.monitor.sample();
      const route = `/processes/${identity.processInstanceId}/terminate`;
      assert.equal(
        (
          await f.request(
            route,
            "POST",
            { requestId: randomUUID(), force: false },
            remote,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await f.request("/remote-control", "PUT", {
            expectedRevision: 0,
            enabled: true,
          })
        ).status,
        200,
      );
      const snapshot = await (
        await f.request("", "GET", undefined, remote)
      ).json();
      assert.equal(snapshot.canTerminate, true);
      assert.equal(snapshot.canManageRemoteControl, false);
      assert.equal(
        (
          await f.request("/remote-control", "PUT", {
            expectedRevision: 0,
            enabled: false,
          })
        ).status,
        409,
      );
      const result = await (
        await f.request(
          route,
          "POST",
          { requestId: randomUUID(), force: false },
          remote,
        )
      ).json();
      assert.equal(result.state, "still_running");
      assert.equal(result.forceAllowed, true);
      assert.equal(
        (
          await f.request("/remote-control", "PUT", {
            expectedRevision: 1,
            enabled: false,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await f.request(
            route,
            "POST",
            { requestId: randomUUID(), force: true },
            remote,
          )
        ).status,
        403,
      );
      assert.equal(child.signalCode, null);
      assert.equal(
        (
          await f.request("/remote-control", "PUT", {
            expectedRevision: 2,
            enabled: true,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await f.request(
            route,
            "POST",
            { requestId: randomUUID(), force: true },
            remote,
          )
        ).status,
        409,
      );
      assert.equal(child.signalCode, null);
      const refreshed = await (
        await f.request(
          route,
          "POST",
          { requestId: randomUUID(), force: false },
          remote,
        )
      ).json();
      assert.equal(refreshed.forceAllowed, true);
      const forced = await (
        await f.request(
          route,
          "POST",
          { requestId: randomUUID(), force: true },
          remote,
        )
      ).json();
      assert.equal(forced.state, "exited");
      await pause(50);
      assert.equal(child.signalCode, "SIGKILL");
      const reopened = await ResourceMonitorStore.create(
        path.join(f.directory, "resources"),
      );
      assert.equal(reopened.snapshot().remoteControl.enabled, true);
      assert.equal(reopened.snapshot().remoteControl.revision, 3);
      await reopened.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await pause(100);
    }
  },
);
await run(
  "real single PID exit, duplicate request, changed identity, explicit force",
  async (f) => {
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { stdio: "ignore" },
    );
    const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    try {
      await pause(150);
      const identity = (await readIdentity(
        child.pid!,
        AbortSignal.timeout(5000),
      ))!;
      identity.actionKind = "terminate";
      f.next.identities.set(identity.processInstanceId, identity);
      await f.monitor.sample();
      const route = `/processes/${identity.processInstanceId}/terminate`;
      const body = { requestId: randomUUID(), force: false };
      assert.equal(
        (
          await f.request(route, "POST", {
            requestId: randomUUID(),
            force: true,
          })
        ).status,
        409,
      );
      const [a, b] = await Promise.all([
        f.request(route, "POST", body),
        f.request(route, "POST", body),
      ]);
      const result = await a.json();
      assert.deepEqual(result, await b.json());
      assert.equal(result.state, "still_running");
      assert.equal(result.forceAllowed, true);
      assert.equal(
        (await f.request(route, "POST", { ...body, force: true })).status,
        409,
      );
      assert.equal(other.exitCode, null);
      const forced = await (
        await f.request(route, "POST", { requestId: randomUUID(), force: true })
      ).json();
      assert.equal(forced.state, "exited");
      await pause(100);
      assert.equal(child.signalCode, "SIGKILL");
      assert.equal(other.exitCode, null);
      const staleIdentity = {
        ...(await readIdentity(other.pid!, AbortSignal.timeout(5000)))!,
        processInstanceId: "old-identity",
        actionKind: "terminate" as const,
      };
      f.next.identities.set("old-identity", staleIdentity);
      await f.monitor.sample();
      assert.equal(
        (
          await f.request("/processes/old-identity/terminate", "POST", {
            requestId: randomUUID(),
            force: false,
          })
        ).status,
        409,
      );
      assert.equal(other.exitCode, null);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      if (other.exitCode === null && other.signalCode === null)
        other.kill("SIGTERM");
      await pause(100);
    }
  },
);
await run(
  "real cooperative SIGTERM exit and already-exited instance",
  async (f) => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    try {
      await pause(100);
      const identity = (await readIdentity(
        child.pid!,
        AbortSignal.timeout(5000),
      ))!;
      identity.actionKind = "terminate";
      f.next.identities.set(identity.processInstanceId, identity);
      await f.monitor.sample();
      const route = `/processes/${identity.processInstanceId}/terminate`;
      const result = await (
        await f.request(route, "POST", {
          requestId: randomUUID(),
          force: false,
        })
      ).json();
      assert.equal(result.state, "exited");
      await pause(50);
      assert.equal(child.signalCode, "SIGTERM");
      const again = await (
        await f.request(route, "POST", {
          requestId: randomUUID(),
          force: false,
        })
      ).json();
      assert.equal(again.state, "already_exited");
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
    }
  },
);
await run(
  "owned service routes through manager stop and verifies exit",
  async (f) => {
    f.enableProject();
    const file = path.join(f.directory, "owned.cjs");
    await writeFile(
      file,
      "const fs=require('fs');fs.writeFileSync('owned.pid',String(process.pid));require('http').createServer((_,r)=>r.end('ok')).listen(Number(process.env.RUNWEAVE_SERVICE_PORT),'127.0.0.1')",
    );
    const quote = (value: string) =>
      "'" + value.replaceAll("'", "'\"'\"'") + "'";
    await writeFile(
      path.join(f.directory, "runweave.json"),
      JSON.stringify({
        schemaVersion: 1,
        services: {
          fixture: {
            command: `exec ${quote(process.execPath)} ${quote(file)}`,
            healthCheck: { path: "/health" },
          },
        },
      }),
    );
    const listed = await f.manager.list("fixture-project", "fixture-project");
    await f.manager.start({
      parentProjectId: "fixture-project",
      projectId: "fixture-project",
      serviceName: "fixture",
      configRevision: listed.config.revision!,
    });
    let pid = 0;
    for (let i = 0; i < 40; i++) {
      try {
        pid = Number(
          await readFile(path.join(f.directory, "owned.pid"), "utf8"),
        );
        break;
      } catch {
        await pause(50);
      }
    }
    assert(pid > 0);
    assert(f.manager.findOwnedProcess(pid));
    const identity = (await readIdentity(pid, AbortSignal.timeout(5000)))!;
    f.next.identities.set(identity.processInstanceId, identity);
    f.next.snapshot.processes.push({
      ...f.next.snapshot.processes[0]!,
      pid,
      processInstanceId: identity.processInstanceId,
    });
    await f.monitor.sample();
    assert.equal(
      f.monitor.snapshot(true).snapshot!.processes.find((p) => p.pid === pid)!
        .actionKind,
      "stop_service",
    );
    const result = await (
      await f.request(
        `/processes/${identity.processInstanceId}/terminate`,
        "POST",
        { requestId: randomUUID(), force: false },
      )
    ).json();
    assert.equal(result.state, "exited");
    assert.equal(await readIdentity(pid, AbortSignal.timeout(5000)), null);
    assert.equal(f.manager.findOwnedProcess(pid), null);
  },
);

await run(
  "many idle apps cannot evict the actual high-use observation",
  async (f) => {
    const start = Date.now();
    for (let i = 0; i < 6; i++) {
      f.next = baseSample();
      f.next.snapshot.sampledAt = start + i * 60000;
      const idle = Array.from({ length: 300 }, (_, j) => ({
        ...f.next.snapshot.apps[0]!,
        appKey: `idle-${j}`,
        energyImpact: 0,
        memoryMb: 20,
      }));
      f.next.snapshot.apps = [...idle, ...f.next.snapshot.apps];
      await f.monitor.sample();
    }
    assert.equal(f.monitor.snapshot(true).alerts.length, 1);
    assert.equal(f.monitor.snapshot(true).alerts[0]!.appKey, "fixture-app");
  },
);
await run(
  "monotonic observation ignores wall clock jumps and stale reads",
  async (f) => {
    const start = Date.now();
    for (let i = 0; i < 6; i++) {
      f.next = baseSample();
      f.tick = i * 60000;
      f.next.snapshot.sampledAt = start + (i % 2 === 0 ? 86400000 : -86400000);
      await f.monitor.sample();
    }
    assert.equal(f.monitor.snapshot(true).alerts.length, 1);
    assert.equal(f.monitor.snapshot(true).alerts[0]!.lastAt, start - 86400000);
    f.tick = 480001;
    assert.equal(f.monitor.snapshot(true).status, "stale");
    assert.equal(f.monitor.snapshot(true).canTerminate, false);
  },
);
await run(
  "sampler failure preserves success age; storage failure does not emit alerts",
  async (f) => {
    await f.monitor.sample();
    const first = f.monitor.snapshot(true);
    f.fail = true;
    await f.monitor.sample();
    const failed = f.monitor.snapshot(true);
    assert.equal(failed.status, "error");
    assert.equal(failed.snapshot!.sampledAt, first.snapshot!.sampledAt);
    assert.equal(failed.alerts.length, 0);
    assert.equal(f.device.snapshot().sampleStatus, "ok");
    f.fail = false;
    await f.monitor.store.close();
    await f.monitor.sample();
    assert.equal(f.monitor.snapshot(true).status, "error");
    assert.equal(f.monitor.snapshot(true).canTerminate, false);
  },
);
await run(
  "five second deadline cancels one shared sample and shutdown drains it",
  async (f) => {
    f.delay = true;
    const first = f.monitor.sample();
    const duplicate = f.monitor.sample();
    assert.equal(first, duplicate);
    await first;
    assert.equal(f.calls, 1);
    assert.equal(f.monitor.snapshot(true).status, "error");
  },
);
const directory = await mkdtemp(path.join(os.tmpdir(), "rw-resource-store-"));
try {
  const store = await ResourceMonitorStore.create(directory);
  await store.update((state) => {
    state.settings.alertsEnabled = false;
    state.settings.revision = 7;
  });
  await store.close();
  const reopened = await ResourceMonitorStore.create(directory);
  assert.equal(reopened.snapshot().settings.revision, 7);
  assert.equal(reopened.snapshot().settings.alertsEnabled, false);
  await reopened.close();
  const file = path.join(directory, "state.json");
  await writeFile(file, "{broken");
  await assert.rejects(() => ResourceMonitorStore.create(directory));
  assert.equal(await readFile(file, "utf8"), "{broken");
  checks.push("restart retains settings and damaged state remains intact");
} finally {
  await rm(directory, { recursive: true, force: true });
}

const helper = path.join(
  repositoryRoot,
  "backend/.native-artifacts/resource-sampler",
);
const sampler = createResourceSampler(helper);
const battery = {
  presence: "present",
  percent: 100,
  powerSource: "ac",
  chargeState: "full",
  remainingMinutes: null,
} as const;
const first = await sampler(AbortSignal.timeout(5000), battery);
await pause(1100);
const second = await sampler(AbortSignal.timeout(5000), battery);
assert.equal(first.snapshot.cpu.totalPercent, null);
assert(second.coverage.matchedProcesses > 0);
assert.equal(
  second.snapshot.battery.available && second.snapshot.battery.dischargePowerW,
  null,
);
assert(second.snapshot.processes.some((p) => p.actionKind === "readonly"));
checks.push(
  "real native sampling, warmup, non-root coverage and AC power semantics",
);
assert.equal(signedBatteryCurrent("18446744073709549823"), -1793);
assert.equal(signedBatteryCurrent("-1793"), -1793);
assert.equal(signedBatteryCurrent("36893488147419103232"), null);
const counters = new ResourceCounters();
counters.read("clock\t0\t125\t3\ncoverage\t1\t1\n1\t7\t0\t0\t0");
const metric = counters.read(
  "clock\t1440000000\t125\t3\ncoverage\t1\t1\n1\t7\t1440000000\t0\t120",
);
assert.equal(metric.scores.get(1)!.cpu, 100);
assert.equal(metric.scores.get(1)!.power, 100.1);
checks.push("exact integer battery decoding and mach tick/wakeup conversion");
console.log(JSON.stringify({ ok: true, checks }, null, 2));
