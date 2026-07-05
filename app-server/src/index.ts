import http from "node:http";
import { mkdir } from "node:fs/promises";
import type { WebSocketServer } from "ws";
import { resolveAppServerConfig } from "./config.js";
import { loadOrCreateToken } from "./auth.js";
import { AppServerCloudSyncSim } from "./cloud-sync-sim.js";
import { AppServerEventCenter } from "./event-center.js";
import { AppServerEventStore } from "./event-store.js";
import { createHttpApp } from "./http-server.js";
import { AppServerStateProjector } from "./state-projector.js";
import { AppServerStateStore } from "./state-store.js";
import {
  acquireSingletonLock,
  preflightSingleton,
  releaseLock,
  type AppServerLock,
} from "./singleton.js";
import { attachEventStreamWebSocketServer } from "./websocket-server.js";

async function main(): Promise<void> {
  const config = resolveAppServerConfig();
  await mkdir(config.stateDir, { recursive: true });

  const preflight = await preflightSingleton(config.lockPath);
  if (preflight.status === "owned") {
    console.log(
      `Runweave app-server already running at http://${preflight.lock.host}:${preflight.lock.port}`,
    );
    return;
  }

  const token = await loadOrCreateToken(config.tokenPath);
  const store = new AppServerEventStore(config.eventLogPath);
  await store.initialize();
  const stateStore = new AppServerStateStore(
    config.threadStatePath,
    config.agentSessionStatePath,
  );
  await stateStore.initialize();
  stateStore.clear();
  const stateProjector = new AppServerStateProjector(stateStore);
  for (const event of store.listAll()) {
    stateProjector.project(event);
  }
  await stateStore.persist();
  const sourceInstanceId = `app-server:${process.pid}`;
  const cloudSync = new AppServerCloudSyncSim({
    syncDir: config.cloudSyncDir,
    stateDir: config.stateDir,
    instanceId: sourceInstanceId,
    version: config.version,
  });
  await cloudSync.initialize();
  await cloudSync.sync({
    events: store.listAll(),
    ...stateStore.getSnapshot(),
    threadChanges: [],
    agentSessionChanges: [],
  });
  const eventCenter = new AppServerEventCenter(store, {
    sourceInstanceId,
    stateStore,
    stateProjector,
    cloudSync,
  });
  const app = createHttpApp({
    eventCenter,
    token,
    version: config.version,
  });
  const server = http.createServer(app);
  const eventStreamServer = attachEventStreamWebSocketServer({
    server,
    eventCenter,
    token,
  });

  const port = await listen(server, config.requestedPort, config.host);
  const lock: AppServerLock = {
    pid: process.pid,
    host: config.host,
    port,
    startedAt: new Date().toISOString(),
    version: config.version,
    source: config.source,
    releaseId: config.releaseId,
    entry: config.entry,
    runtimeRoot: config.runtimeRoot,
  };
  const acquire = await acquireSingletonLock(config.lockPath, lock);
  if (acquire.status === "owned") {
    await closeServer(server);
    console.log(
      `Runweave app-server already running at http://${acquire.lock.host}:${acquire.lock.port}`,
    );
    return;
  }
  console.log(`Runweave app-server listening at http://${lock.host}:${port}`);

  attachShutdownHandlers(server, eventStreamServer, config.lockPath);
}

function listen(
  server: http.Server,
  port: number,
  host: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to resolve app-server listen address"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function closeEventStreamServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.close();
  }
  return new Promise((resolve) => {
    const forceClose = setTimeout(() => {
      for (const client of wss.clients) {
        client.terminate();
      }
    }, 1000);
    wss.close(() => {
      clearTimeout(forceClose);
      resolve();
    });
  });
}

function attachShutdownHandlers(
  server: http.Server,
  eventStreamServer: WebSocketServer,
  lockPath: string,
): void {
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await closeEventStreamServer(eventStreamServer);
    await closeServer(server);
    await releaseLock(lockPath);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
