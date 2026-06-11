import os from "node:os";
import { pathToFileURL } from "node:url";

import {
  delay,
  resolvePort,
  spawnRawProcess,
  spawnManagedProcess,
  startBackend,
  stopProcesses,
  waitForBackendReady,
} from "./dev.mjs";

const DEFAULT_BACKEND_PORT = 5001;
const DEFAULT_APP_PORT = 5174;
const DEV_HOST = process.env.DEV_HOST?.trim() || "0.0.0.0";
const APP_DEV_IOS_ENABLED = process.env.APP_DEV_IOS === "true";
const APP_DEV_READY_TIMEOUT_MS = 30_000;
const APP_DEV_READY_INTERVAL_MS = 200;
const DEFAULT_IOS_TARGET_NAME = "iPhone 17 Pro";
const IOS_CAP_ARGS = process.argv.slice(2);

function isWildcardHost(host) {
  return host === "0.0.0.0" || host === "::" || host === "";
}

function formatUrlHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function resolveLocalAccessHost(host) {
  return isWildcardHost(host) ? "localhost" : host;
}

function resolveLanIpv4Address() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }
  return null;
}

function resolveLiveReloadHost(host, env = process.env) {
  const configuredHost = env.APP_DEV_LIVE_RELOAD_HOST?.trim();
  if (configuredHost) {
    return configuredHost;
  }

  if (isWildcardHost(host)) {
    return resolveLanIpv4Address() ?? "127.0.0.1";
  }

  if (host === "localhost") {
    return "127.0.0.1";
  }

  return host;
}

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

function startIosLiveReload({ host, appPort, env, capArgs = [] }) {
  return spawnRawProcess(
    "ios",
    "pnpm",
    [
      "--filter",
      "@runweave/app",
      "cap",
      "run",
      "ios",
      "--live-reload",
      "--host",
      host,
      "--port",
      String(appPort),
      ...capArgs,
    ],
    env,
  );
}

function hasIosTargetArg(capArgs) {
  return capArgs.some(
    (arg) =>
      arg === "--target" ||
      arg.startsWith("--target=") ||
      arg === "--target-name" ||
      arg.startsWith("--target-name="),
  );
}

function resolveIosCapArgs(capArgs) {
  if (hasIosTargetArg(capArgs)) {
    return capArgs;
  }
  return ["--target-name", DEFAULT_IOS_TARGET_NAME, ...capArgs];
}

async function waitForAppReady(app, appUrl) {
  const deadline = Date.now() + APP_DEV_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (app.child.exitCode !== null || app.child.signalCode !== null) {
      throw new Error(
        `app exited before becoming ready (code=${app.child.exitCode}, signal=${app.child.signalCode})`,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);

    try {
      const response = await fetch(appUrl, {
        signal: controller.signal,
      });

      if (response.ok) {
        return;
      }
    } catch {
      // Continue polling until timeout.
    } finally {
      clearTimeout(timeout);
    }

    await delay(APP_DEV_READY_INTERVAL_MS);
  }

  throw new Error(
    `app did not become ready within ${APP_DEV_READY_TIMEOUT_MS}ms: ${appUrl}`,
  );
}

function watchAppDevProcesses(requiredProcesses, transientProcesses = []) {
  const allProcesses = [...requiredProcesses, ...transientProcesses];

  return new Promise((resolve) => {
    let stopping = false;

    const cleanup = () => {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    };

    const stopAndResolve = async (exitCode) => {
      if (stopping) {
        return;
      }

      stopping = true;
      cleanup();
      await stopProcesses(allProcesses);
      resolve(exitCode);
    };

    const handleSignal = () => {
      void stopAndResolve(0);
    };

    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);

    for (const processInfo of requiredProcesses) {
      processInfo.child.on("error", (error) => {
        console.error(`[app-dev] ${processInfo.name} failed to start`, error);
        void stopAndResolve(1);
      });

      processInfo.child.on("exit", (code) => {
        if (!stopping) {
          void stopAndResolve(code ?? 1);
        }
      });
    }

    for (const processInfo of transientProcesses) {
      processInfo.child.on("error", (error) => {
        console.error(`[app-dev] ${processInfo.name} failed to start`, error);
        void stopAndResolve(1);
      });

      processInfo.child.on("exit", (code) => {
        if (stopping) {
          return;
        }

        if (code === 0) {
          console.log(
            `[app-dev] ${processInfo.name} command completed; dev servers remain running.`,
          );
          return;
        }

        void stopAndResolve(code ?? 1);
      });
    }
  }).then((exitCode) => {
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  });
}

async function run() {
  const reservedPorts = new Set();
  const iosCapArgs = resolveIosCapArgs(IOS_CAP_ARGS);

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

  const localAccessHost = resolveLocalAccessHost(DEV_HOST);
  const liveReloadHost = resolveLiveReloadHost(DEV_HOST);
  const backendUrl = `http://${formatUrlHost(localAccessHost)}:${backendPort}`;
  const appUrl = `http://${formatUrlHost(localAccessHost)}:${appPort}`;
  const liveReloadUrl = `http://${formatUrlHost(liveReloadHost)}:${appPort}`;

  console.log(`[app-dev] backend=${backendPort} app=${appPort}`);
  console.log(`[app-dev] backend url: ${backendUrl}`);
  console.log(`[app-dev] app url: ${appUrl}`);
  if (APP_DEV_IOS_ENABLED) {
    console.log(`[app-dev] iOS live reload url: ${liveReloadUrl}`);
    console.log(`[app-dev] iOS capacitor args: ${iosCapArgs.join(" ")}`);
  }

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

  try {
    await waitForAppReady(app, appUrl);
  } catch (error) {
    await stopProcesses([backend, app]);
    throw error;
  }

  const transientProcesses = [];
  if (APP_DEV_IOS_ENABLED) {
    console.log("[app-dev] app ready, starting iOS live reload...");
    transientProcesses.push(
      startIosLiveReload({
        host: liveReloadHost,
        appPort,
        env: process.env,
        capArgs: iosCapArgs,
      }),
    );
  } else {
    console.log("[app-dev] iOS live reload disabled (APP_DEV_IOS=false).");
  }

  await watchAppDevProcesses([backend, app], transientProcesses);
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
