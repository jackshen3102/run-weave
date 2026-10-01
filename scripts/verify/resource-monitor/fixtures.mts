// Isolated HTTP/lifecycle acceptance fixtures, not unit tests. No user process is signalled.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { AuthService } from "../../../backend/src/auth/service";
import { createRequireAuth } from "../../../backend/src/auth/middleware";
import { createResourceMonitorRouter } from "../../../backend/src/routes/resource-monitor";
import { DeviceMonitorService } from "../../../backend/src/device-monitor/service";
import { DeviceMonitorStore } from "../../../backend/src/device-monitor/store";
import { ResourceMonitorStore } from "../../../backend/src/resource-monitor/store";
import { ResourceMonitorService } from "../../../backend/src/resource-monitor/service";
import { RuntimeStatusWorkspaceServiceManager } from "../../../backend/src/runtime-status/workspace-service-manager";
import { type ResourceSample } from "../../../backend/src/resource-monitor/sampler";
export const repositoryRoot = fileURLToPath(
  new URL("../../../", import.meta.url),
);
const requireBackend = createRequire(
  path.join(repositoryRoot, "backend/package.json"),
);
const express = requireBackend("express");
export const pause = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
export const checks: string[] = [];
export const baseSample = (): ResourceSample => ({
  identities: new Map(),
  coverage: { knownProcesses: 1, matchedProcesses: 1, complete: true },
  snapshot: {
    sampledAt: Date.now(),
    platform: "darwin",
    cpu: { totalPercent: 10, coreCount: 12, warmingUp: false },
    memory: { totalMb: 36864, usedMb: 8192, pressure: "normal", swapUsedMb: 0 },
    battery: {
      available: true,
      percent: 70,
      charging: false,
      powerSource: "battery",
      dischargeRateMa: -1793,
      dischargePowerW: 22.6,
      timeRemainingMin: null,
    },
    apps: [
      {
        appKey: "fixture-app",
        appName: "Acceptance fixture",
        processCount: 1,
        cpuPercent: 100,
        energyImpact: 100,
        memoryMb: 100,
        pids: [123],
        coverage: "complete",
        isCurrentApp: false,
      },
    ],
    processes: [
      {
        pid: 123,
        ppid: 1,
        displayName: "Acceptance fixture",
        executableName: "fixture",
        processInstanceId: "fixture-instance",
        appKey: "fixture-app",
        appName: "Acceptance fixture",
        cpuPercent: 100,
        memoryMb: 100,
        coverage: "complete",
        isCurrentApp: false,
      },
    ],
  },
});
export async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rw-resource-acceptance-"),
  );
  const device = new DeviceMonitorService(
    await DeviceMonitorStore.create(path.join(directory, "device")),
    async () => ({
      presence: "present",
      percent: 70,
      powerSource: "battery",
      chargeState: "discharging",
      remainingMinutes: null,
    }),
  );
  await device.sample();
  let projectEnabled = false;
  const manager = new RuntimeStatusWorkspaceServiceManager({
    getProjectContext: (id: string) =>
      projectEnabled && id === "fixture-project"
        ? {
            availability: "available",
            isPrimary: true,
            name: "fixture",
            parentProjectId: "fixture-project",
            projectId: "fixture-project",
            path: directory,
          }
        : null,
    listProjects: () =>
      projectEnabled ? [{ id: "fixture-project", name: "fixture" }] : [],
  } as never);
  let next = baseSample();
  let calls = 0;
  let tick: number | null = null;
  let fail = false;
  let delay = false;
  const monitor = new ResourceMonitorService(
    await ResourceMonitorStore.create(path.join(directory, "resources")),
    device,
    manager,
    async (signal: AbortSignal) => {
      calls++;
      if (fail) throw new Error("fixture sampler failure");
      if (delay)
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      return structuredClone(next);
    },
    () => tick ?? next.snapshot.sampledAt,
  );
  const password = randomUUID();
  const auth = new AuthService({
    username: "fixture",
    password,
    jwtSecret: randomBytes(32).toString("hex"),
    accessTokenTtlMs: 3600_000,
    refreshTokenTtlMs: 86400_000,
    refreshCookieName: "fixture",
    secureCookies: false,
  });
  const login = (await auth.login("fixture", password))!;
  const app = express();
  app.use(express.json());
  app.use(
    "/api/device/resources",
    createRequireAuth(auth),
    createResourceMonitorRouter(monitor, auth),
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (
    suffix = "",
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(base + "/api/device/resources" + suffix, {
      method,
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    directory,
    enableProject() {
      projectEnabled = true;
      manager.setProxyPort(49999);
    },
    set tick(value: number) {
      tick = value;
    },
    set fail(value: boolean) {
      fail = value;
    },
    set delay(value: boolean) {
      delay = value;
    },
    device,
    manager,
    monitor,
    auth,
    login,
    request,
    get calls() {
      return calls;
    },
    get next() {
      return next;
    },
    set next(value: ResourceSample) {
      next = value;
    },
    async dispose() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await monitor.dispose();
      await manager.dispose();
      await device.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export async function run(
  name: string,
  body: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  const f = await fixture();
  try {
    await body(f);
    checks.push(name);
    console.log(`PASS ${name}`);
  } finally {
    await f.dispose();
  }
}
export async function window(
  f: Awaited<ReturnType<typeof fixture>>,
  value: number,
  start = Date.now(),
) {
  for (let i = 0; i < 6; i++) {
    f.next = baseSample();
    f.next.snapshot.sampledAt = start + i * 60_000;
    f.next.snapshot.apps[0]!.energyImpact = value;
    await f.monitor.sample();
  }
}
