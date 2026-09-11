import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as httpServer, type Server } from "node:http";
import { createServer as httpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
const requireBackend = createRequire(path.resolve("../backend/package.json"));
const express = requireBackend("express");
const { WebSocket } = requireBackend("ws");
import { AuthService } from "../../../backend/src/auth/service";
import { createRequireAuth } from "../../../backend/src/auth/middleware";
import { createAuthRouter } from "../../../backend/src/routes/auth";
import { DeviceMonitorService } from "../../../backend/src/device-monitor/service";
import { DeviceMonitorStore } from "../../../backend/src/device-monitor/store";
import { DeviceSubscriptions } from "../../../backend/src/device-monitor/subscriptions";
import { BatteryAlerts } from "../../../backend/src/device-monitor/delivery";
import { PushClient } from "../../../backend/src/device-monitor/push-client";
import { createDeviceStatusRouter } from "../../../backend/src/routes/device-status";
import { createDeviceNotificationsRouter } from "../../../backend/src/routes/device-notifications";
import { attachTerminalEventsWebSocketServer } from "../../../backend/src/ws/terminal-events-server";
import { createHttpUpgradeRouter } from "../../../backend/src/server/http-upgrade-router";
import { TerminalEventService } from "../../../backend/src/terminal/state/terminal-event-service";
import { GatewayStore } from "../../../packages/push-gateway/src/store";
import { createGateway } from "../../../packages/push-gateway/src/app";
import { hash } from "../../../packages/push-gateway/src/auth";
import type { APNsTransport } from "../../../packages/push-gateway/src/apns";
import type { BatterySampler } from "../../../backend/src/device-monitor/sampler";

export async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  return (server.address() as AddressInfo).port;
}
export async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
export const pause = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
export async function eventually(
  check: () => boolean,
  timeout = 5000,
): Promise<void> {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > until) throw new Error("Condition timed out");
    await pause(15);
  }
}
export async function fixture(
  sampler: BatterySampler,
  transport: APNsTransport,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "runweave-battery-"));
  const monitorStore = await DeviceMonitorStore.create(
    path.join(directory, "monitor"),
  );
  const monitor = new DeviceMonitorService(monitorStore, sampler);
  const gatewayStore = new GatewayStore(path.join(directory, "gateway"));
  const credential = randomBytes(32).toString("hex");
  gatewayStore.update((data) => {
    data.senders[hash(credential)] = {
      hostId: monitor.snapshot().hostId,
      environments: ["sandbox"],
    };
  });
  const unboundGateway = createGateway(gatewayStore, transport);
  const gateway = httpsServer(
    {
      cert: await readFile(process.env.BATTERY_FIXTURE_CERT!),
      key: await readFile(process.env.BATTERY_FIXTURE_KEY!),
    },
    unboundGateway.listeners("request")[0] as never,
  );
  const gatewayURL = `https://localhost:${await listen(gateway)}`;
  const push = new PushClient(
    gatewayURL,
    credential,
    monitor.snapshot().hostId,
  );
  const password = randomBytes(24).toString("hex");
  const auth = new AuthService({
    username: "battery-fixture",
    password,
    jwtSecret: randomBytes(32).toString("hex"),
    accessTokenTtlMs: 3600_000,
    refreshTokenTtlMs: 24 * 3600_000,
    refreshCookieName: "fixture",
    secureCookies: false,
  });
  const subscriptions = new DeviceSubscriptions(monitorStore, auth, push);
  const alerts = new BatteryAlerts(monitor, subscriptions);
  const app = express();
  app.use(express.json({ limit: "8kb" }));
  app.use("/api/auth", createAuthRouter(auth));
  app.use(
    "/api/device",
    createRequireAuth(auth),
    createDeviceStatusRouter(monitor),
  );
  app.use(
    "/api/device/notifications",
    createRequireAuth(auth),
    createDeviceNotificationsRouter(subscriptions, auth),
  );
  const server = httpServer(app);
  const events = new TerminalEventService();
  const sockets = attachTerminalEventsWebSocketServer(
    createHttpUpgradeRouter(server),
    auth,
    events,
    { deviceMonitor: monitor },
  );
  const baseURL = `http://localhost:${await listen(server)}`;
  async function request(
    route: string,
    token?: string,
    method = "GET",
    body?: unknown,
  ) {
    return fetch(baseURL + route, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function login(connectionId = randomUUID()) {
    const response = await fetch(baseURL + "/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Client": "app",
        "X-Connection-ID": connectionId,
      },
      body: JSON.stringify({ username: "battery-fixture", password }),
    });
    if (!response.ok)
      throw new Error(`Fixture login failed ${response.status}`);
    return {
      ...((await response.json()) as {
        accessToken: string;
        sessionId: string;
        refreshToken: string;
      }),
      connectionId,
    };
  }
  async function register(
    owner: Awaited<ReturnType<typeof login>>,
    installation = randomUUID(),
    explicit = true,
    deviceToken = "ab".repeat(48),
  ) {
    const response = await request(
      `/api/device/notifications/subscriptions/${installation}`,
      owner.accessToken,
      "PUT",
      {
        connectionId: owner.connectionId,
        deviceToken,
        environment: "sandbox",
        displayName: "Battery Fixture",
        enabled: true,
        explicitEnable: explicit,
      },
    );
    if (!response.ok)
      throw new Error(`Fixture registration failed ${response.status}`);
    const value = (await response.json()) as {
      subscriptionId: string;
      revokeToken: string;
      hostId: string;
      state: string;
      version: number;
    };
    if (value.revokeToken && value.state !== "disabled") {
      const confirmed = await request(
        `/api/device/notifications/subscriptions/${installation}/confirm`,
        owner.accessToken,
        "POST",
        { subscriptionId: value.subscriptionId, version: value.version },
      );
      if (!confirmed.ok)
        throw new Error(`Fixture confirmation failed ${confirmed.status}`);
    }
    return value;
  }

  function socket(owner: Awaited<ReturnType<typeof login>>, device = true) {
    const ticket = auth.issueTemporaryToken({
      sessionId: owner.sessionId,
      tokenType: "terminal-events-ws",
      resource: {},
      ttlMs: 10_000,
    });
    return new WebSocket(
      baseURL.replace("http:", "ws:") +
        `/ws/terminal-events?token=${ticket.token}&after=&deviceStatus=${device ? 1 : 0}`,
    );
  }
  async function gatewayRequest(
    route: string,
    body?: unknown,
    method = "POST",
    bearer = credential,
  ) {
    return fetch(gatewayURL + route, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function dispose() {
    await alerts.dispose();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await close(server);
    await close(gateway);
    await monitor.dispose();
    gatewayStore.close();
    await rm(directory, { recursive: true, force: true });
  }
  return {
    directory,
    monitor,
    monitorStore,
    gatewayStore,
    auth,
    subscriptions,
    alerts,
    push,
    request,
    login,
    register,
    socket,
    gatewayRequest,
    dispose,
    events,
  };
}
