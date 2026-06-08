import { pathToFileURL } from "node:url";

import {
  delay,
  resolvePort,
  spawnManagedProcess,
  startBackend,
  stopProcesses,
  waitForBackendReady,
  watchProcesses,
} from "./dev.mjs";

const DEFAULT_BACKEND_PORT = 5001;
const DEFAULT_APP_PORT = 5174;
const DEV_HOST = process.env.DEV_HOST?.trim() || "0.0.0.0";

function createAppEnv({ baseEnv, backendPort, appHost, appPort }) {
  return {
    ...baseEnv,
    VITE_PROXY_TARGET: `http://localhost:${backendPort}`,
    VITE_STRICT_PORT: "true",
    VITE_DEV_PORT: String(appPort),
    ...(appHost ? { VITE_DEV_HOST: appHost } : {}),
    VITE_RUNWEAVE_API_BASE: "",
  };
}

function startApp({ host, backendPort, appPort, env }) {
  return spawnManagedProcess(
    "app",
    ["-C", "./app", "dev", "--", "--port", String(appPort), "--host", host],
    createAppEnv({
      baseEnv: env,
      backendPort,
      appHost: host,
      appPort,
    }),
  );
}

async function run() {
  const reservedPorts = new Set();

  const backendPort = await resolvePort(DEFAULT_BACKEND_PORT, {
    reservedPorts,
    host: DEV_HOST,
  });
  reservedPorts.add(backendPort);

  const appPort = await resolvePort(DEFAULT_APP_PORT, {
    reservedPorts,
    host: DEV_HOST,
  });
  reservedPorts.add(appPort);

  const backendUrl = `http://localhost:${backendPort}`;
  const appUrl = `http://localhost:${appPort}`;

  console.log(`[app-dev] backend=${backendPort} app=${appPort}`);
  console.log(`[app-dev] backend url: ${backendUrl}`);
  console.log(`[app-dev] app url: ${appUrl}`);

  const backend = startBackend({
    host: DEV_HOST,
    backendPort,
    env: process.env,
  });

  try {
    await waitForBackendReady(backend, backendUrl);
  } catch (error) {
    await stopProcesses([backend]);
    throw error;
  }

  console.log("[app-dev] backend ready, starting app...");

  const app = startApp({
    host: DEV_HOST,
    backendPort,
    appPort,
    env: process.env,
  });

  await delay(200);
  await watchProcesses([backend, app], { logPrefix: "[app-dev]" });
}

const isDirectExecution =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  run().catch((error) => {
    console.error("[app-dev] failed to start", error);
    process.exit(1);
  });
}
