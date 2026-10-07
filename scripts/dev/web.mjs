import { pathToFileURL } from "node:url";
import {
  resolvePort,
  stopProcesses,
  waitForBackendReady,
  startBackend,
  startFrontend,
  watchProcesses,
} from "./runtime.mjs";
export {
  createBackendEnv,
  resolveHealthcheckTimeoutMs,
  createFrontendEnv,
  resolvePort,
  delay,
  spawnManagedProcess,
  spawnRawProcess,
  childHasExited,
  stopProcesses,
  waitForBackendReady,
  startBackend,
  startFrontend,
  watchProcesses,
  resolveElectronBin,
  bundleElectron,
} from "./runtime.mjs";

const DEFAULT_BACKEND_PORT = 5000;
const DEFAULT_FRONTEND_PORT = 5173;
const DEV_HOST = process.env.DEV_HOST?.trim() || "0.0.0.0";

async function run() {
  const reservedPorts = new Set();

  const backendPort = await resolvePort(DEFAULT_BACKEND_PORT, {
    reservedPorts,
    host: DEV_HOST,
  });
  reservedPorts.add(backendPort);

  const backend = startBackend({
    host: DEV_HOST,
    backendPort,
    env: process.env,
  });

  const backendUrl = `http://127.0.0.1:${backendPort}`;

  try {
    await waitForBackendReady(backend, backendUrl);
  } catch (error) {
    await stopProcesses([backend]);
    throw error;
  }

  const frontendPort = await resolvePort(DEFAULT_FRONTEND_PORT, {
    reservedPorts,
    host: DEV_HOST,
  });
  reservedPorts.add(frontendPort);

  const frontend = startFrontend({
    host: DEV_HOST,
    backendPort,
    frontendPort,
    env: process.env,
  });

  await watchProcesses([backend, frontend]);
}

const isDirectExecution =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  run().catch((error) => {
    console.error("[dev] failed to start", error);
    process.exit(1);
  });
}
