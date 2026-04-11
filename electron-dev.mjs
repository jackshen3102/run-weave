import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  resolvePort,
  startBackend,
  startFrontend,
  waitForBackendReady,
  stopProcesses,
  watchProcesses,
  delay,
  bundleElectron,
  resolveElectronBin,
  spawnRawProcess,
} from "./dev.mjs";

const DEFAULT_BACKEND_PORT = 5001;
const DEFAULT_FRONTEND_PORT = 5173;
const DEV_HOST = process.env.DEV_HOST?.trim() || "0.0.0.0";

async function run() {
  const reservedPorts = new Set();

  const backendPort = await resolvePort(DEFAULT_BACKEND_PORT, {
    reservedPorts,
    host: DEV_HOST,
  });
  reservedPorts.add(backendPort);

  const frontendPort = await resolvePort(DEFAULT_FRONTEND_PORT, {
    reservedPorts,
    host: DEV_HOST,
  });
  reservedPorts.add(frontendPort);

  const backendUrl = `http://localhost:${backendPort}`;

  console.log(`[electron-dev] backend=${backendPort} frontend=${frontendPort}`);
  console.log(`[electron-dev] backend url: ${backendUrl}`);
  console.log(`[electron-dev] frontend url: http://localhost:${frontendPort}`);

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

  console.log("[electron-dev] backend ready, starting frontend...");

  const frontend = startFrontend({
    host: DEV_HOST,
    backendPort,
    frontendPort,
    env: process.env,
  });

  await delay(3_000);

  console.log("[electron-dev] bundling electron main process...");

  const electronDir = path.resolve("electron");
  bundleElectron(electronDir);

  console.log("[electron-dev] starting electron...");

  const electronBin = resolveElectronBin(electronDir);
  const electronEnv = {
    ...process.env,
    BROWSER_VIEWER_DEV_URL: `http://localhost:${frontendPort}`,
    BROWSER_VIEWER_BACKEND_URL: backendUrl,
    BROWSER_VIEWER_MANAGES_PACKAGED_BACKEND: "false",
  };
  delete electronEnv.ELECTRON_RUN_AS_NODE;

  const electron = spawnRawProcess(
    "electron",
    electronBin,
    [path.join(electronDir, "dist/main.cjs")],
    electronEnv,
  );

  await watchProcesses([backend, frontend, electron], {
    logPrefix: "[electron-dev]",
  });
}

const isDirectExecution =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  run().catch((error) => {
    console.error("[electron-dev] failed to start", error);
    process.exit(1);
  });
}
