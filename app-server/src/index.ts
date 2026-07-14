import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { WebSocketServer } from "ws";
import { resolveAppServerConfig } from "./config.js";
import { loadOrCreateToken } from "./auth.js";
import { AppServerCloudSyncSim } from "./cloud-sync-sim.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import {
  AgentThreadStatusReconciler,
  parseOptionalPositiveInteger,
} from "./agent-thread-status-reconciler.js";
import { AppServerEventCenter } from "./event-center.js";
import { AppServerEventStore } from "./event-store.js";
import { createHttpApp } from "./http-server.js";
import { AppServerStateProjector } from "./state-projector.js";
import { AppServerStateStore } from "./state-store.js";
import { TraeThreadLifecycleReader } from "./trae-thread-lifecycle-reader.js";
import {
  acquireSingletonLock,
  preflightSingleton,
  releaseLock,
  type AppServerLock,
} from "./singleton.js";
import { attachEventStreamWebSocketServer } from "./websocket-server.js";

async function main(): Promise<void> {
  const config = resolveAppServerConfig();
  const serviceInstanceId =
    config.serviceInstanceId ?? `app-server:${randomUUID()}`;
  await mkdir(config.stateDir, { recursive: true });

  const preflight = await preflightSingleton(config.lockPath);
  if (preflight.status === "owned") {
    logInfo("Runweave app-server already running", {
      phase: "preflight",
      ...buildLockLogFields(preflight.lock),
    });
    return;
  }

  const token = await loadOrCreateToken(config.tokenPath);
  const store = new AppServerEventStore(config.eventLogPath);
  await store.initialize();
  const stateStore = new AppServerStateStore(config.threadStatePath);
  await stateStore.initialize();
  stateStore.clear();
  const stateProjector = new AppServerStateProjector(stateStore);
  for (const event of store.listAll()) {
    stateProjector.project(event);
  }
  await stateStore.persist();
  const sourceInstanceId = serviceInstanceId;
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
  });
  const eventCenter = new AppServerEventCenter(store, {
    sourceInstanceId,
    stateStore,
    stateProjector,
    cloudSync,
  });
  const traeLifecycleReader = new TraeThreadLifecycleReader();
  const codexAppServerClient = new CodexAppServerClient();
  const agentThreadStatusReconciler = new AgentThreadStatusReconciler({
    eventCenter,
    sourceInstanceId,
    codexStatusReader: codexAppServerClient,
    traeLifecycleReader,
    startDelayMs: parseOptionalPositiveInteger(
      process.env.RUNWEAVE_APP_SERVER_THREAD_STATUS_START_DELAY_MS ??
        process.env.RUNWEAVE_APP_SERVER_CODEX_STATUS_START_DELAY_MS,
    ),
    intervalMs: parseOptionalPositiveInteger(
      process.env.RUNWEAVE_APP_SERVER_THREAD_STATUS_INTERVAL_MS ??
        process.env.RUNWEAVE_APP_SERVER_CODEX_STATUS_INTERVAL_MS,
    ),
  });
  const app = createHttpApp({
    eventCenter,
    token,
    version: config.version,
    serviceInstanceId,
    devSessionId: config.devSessionId,
    sourceRevision: config.sourceRevision,
    traeLifecycleReader,
    codexThreadDetailReader: codexAppServerClient,
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
    serviceInstanceId,
    ...(config.devSessionId ? { devSessionId: config.devSessionId } : {}),
    ...(config.sourceRevision ? { sourceRevision: config.sourceRevision } : {}),
  };
  const acquire = await acquireSingletonLock(config.lockPath, lock);
  if (acquire.status === "owned") {
    await closeServer(server);
    logInfo("Runweave app-server already running", {
      phase: "acquire",
      attemptedPort: port,
      ...buildLockLogFields(acquire.lock),
    });
    return;
  }
  logInfo("Runweave app-server listening", {
    phase: "listening",
    requestedPort: config.requestedPort,
    ...buildLockLogFields(lock),
    stateDir: config.stateDir,
    eventLogPath: config.eventLogPath,
    threadStatePath: config.threadStatePath,
    cloudSyncDir: config.cloudSyncDir,
  });
  agentThreadStatusReconciler.start();

  attachShutdownHandlers(
    server,
    eventStreamServer,
    config.lockPath,
    agentThreadStatusReconciler,
  );
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
  agentThreadStatusReconciler: AgentThreadStatusReconciler,
): void {
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    agentThreadStatusReconciler.stop();
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

function buildLockLogFields(lock: AppServerLock): Record<string, unknown> {
  return {
    pid: lock.pid,
    baseUrl: `http://${lock.host}:${lock.port}`,
    host: lock.host,
    port: lock.port,
    startedAt: lock.startedAt,
    version: lock.version,
    source: lock.source,
    releaseId: lock.releaseId,
    entry: lock.entry,
    runtimeRoot: lock.runtimeRoot,
    serviceInstanceId: lock.serviceInstanceId,
    devSessionId: lock.devSessionId,
    sourceRevision: lock.sourceRevision,
  };
}

function logInfo(message: string, fields: Record<string, unknown>): void {
  console.log(formatLogEntry("info", message, fields));
}

function logError(message: string, fields: Record<string, unknown>): void {
  console.error(formatLogEntry("error", message, fields));
}

function formatLogEntry(
  level: "info" | "error",
  message: string,
  fields: Record<string, unknown>,
): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: "runweave-app-server",
    message,
    ...fields,
  });
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
    };
  }
  return {
    error: String(error),
  };
}

main().catch((error: unknown) => {
  logError("Runweave app-server failed", serializeError(error));
  process.exitCode = 1;
});
