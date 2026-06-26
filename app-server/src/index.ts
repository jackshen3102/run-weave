import http from "node:http";
import { mkdir } from "node:fs/promises";
import { resolveAppServerConfig } from "./config";
import { loadOrCreateToken } from "./auth";
import { AppServerEventCenter } from "./event-center";
import { AppServerEventStore } from "./event-store";
import { createHttpApp } from "./http-server";
import {
  preflightSingleton,
  releaseLock,
  writeLock,
  type AppServerLock,
} from "./singleton";
import { attachEventStreamWebSocketServer } from "./websocket-server";

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
  const eventCenter = new AppServerEventCenter(store);
  const app = createHttpApp({
    eventCenter,
    token,
    version: config.version,
  });
  const server = http.createServer(app);
  attachEventStreamWebSocketServer({ server, eventCenter, token });

  const port = await listen(server, config.requestedPort, config.host);
  const lock: AppServerLock = {
    pid: process.pid,
    host: config.host,
    port,
    startedAt: new Date().toISOString(),
    version: config.version,
  };
  await writeLock(config.lockPath, lock);
  console.log(`Runweave app-server listening at http://${lock.host}:${port}`);

  attachShutdownHandlers(server, config.lockPath);
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

function attachShutdownHandlers(server: http.Server, lockPath: string): void {
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
