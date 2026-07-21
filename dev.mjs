import net from "node:net";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FORCE_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 30_000;
const HEALTHCHECK_INTERVAL_MS = 200;
const DEV_CHILD_ENV_KEYS_TO_REMOVE = [
  "RUNWEAVE_DEV_URL",
  "RUNWEAVE_BACKEND_URL",
  "RUNWEAVE_MANAGES_PACKAGED_BACKEND",
  "RUNWEAVE_NODE_PTY_DIR",
  "BROWSER_VIEWER_BACKEND_URL",
  "BROWSER_VIEWER_DEV_URL",
  "BROWSER_VIEWER_MANAGES_PACKAGED_BACKEND",
  "BROWSER_VIEWER_NODE_PTY_DIR",
  "ELECTRON_RUN_AS_NODE",
  "RUNWEAVE_BACKEND_PORT",
  "RUNWEAVE_BASE_URL",
  "RUNWEAVE_COMPLETION_HOOK_ENDPOINT",
  "RUNWEAVE_DESKTOP_CHANNEL",
  "RUNWEAVE_HOOK_DEBUG_LOG",
  "RUNWEAVE_HOOK_ENDPOINT",
  "RUNWEAVE_HOOK_TOKEN",
  "RUNWEAVE_PROJECT_ID",
  "RUNWEAVE_RUNTIME_RELEASE_ID",
  "RUNWEAVE_TERMINAL_SESSION_ID",
  "RUNWEAVE_TOOLKIT_PLUGIN_ROOT",
  "RUNWEAVE_TMUX_SESSION_NAME",
];

function createDevChildBaseEnv(baseEnv) {
  const env = { ...baseEnv };
  for (const key of DEV_CHILD_ENV_KEYS_TO_REMOVE) {
    delete env[key];
  }
  return env;
}

function resolveDevBrowserProfileDir(baseEnv) {
  const devProfileDir = baseEnv.RUNWEAVE_DEV_BROWSER_PROFILE_DIR?.trim();
  if (devProfileDir) {
    return devProfileDir;
  }

  const isRunweaveChildShell = Boolean(
    baseEnv.RUNWEAVE_TERMINAL_SESSION_ID?.trim(),
  );
  const allowParentProfile =
    baseEnv.RUNWEAVE_DEV_ALLOW_PARENT_PROFILE?.trim().toLowerCase() === "true";
  if (
    baseEnv.BROWSER_PROFILE_DIR?.trim() &&
    (!isRunweaveChildShell || allowParentProfile)
  ) {
    return baseEnv.BROWSER_PROFILE_DIR;
  }

  const devDefaultProfileId = createHash("sha256")
    .update(process.cwd())
    .digest("hex")
    .slice(0, 8);
  return path.join(
    os.homedir(),
    ".runweave",
    "browser-profile",
    devDefaultProfileId,
  );
}

export function createBackendEnv({
  baseEnv,
  backendPort,
  sourceRoot = process.cwd(),
}) {
  const env = createDevChildBaseEnv(baseEnv);
  const profileDir = resolveDevBrowserProfileDir(baseEnv);
  const sourceRevision = resolveDevSourceRevision(baseEnv);
  return {
    ...env,
    BROWSER_PROFILE_DIR: profileDir,
    BROWSER_DEVTOOLS_ENABLED: baseEnv.BROWSER_DEVTOOLS_ENABLED ?? "true",
    PORT: String(backendPort),
    PORT_STRICT: "true",
    RUNWEAVE_RESOURCE_NAMESPACE: `profile:${createHash("sha256").update(profileDir).digest("hex").slice(0, 12)}`,
    RUNWEAVE_TOOLKIT_PLUGIN_ROOT: path.join(
      path.resolve(sourceRoot),
      "electron",
      "resources",
    ),
    ...(sourceRevision ? { RUNWEAVE_SOURCE_REVISION: sourceRevision } : {}),
    SESSION_RESTORE_ENABLED: baseEnv.SESSION_RESTORE_ENABLED ?? "false",
  };
}

function resolveDevSourceRevision(baseEnv) {
  const explicitRevision = baseEnv.RUNWEAVE_SOURCE_REVISION?.trim();
  if (explicitRevision) {
    return explicitRevision;
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

export function resolveHealthcheckTimeoutMs(env = process.env) {
  const rawValue = env.DEV_BACKEND_HEALTHCHECK_TIMEOUT_MS?.trim();
  if (!rawValue) {
    return DEFAULT_HEALTHCHECK_TIMEOUT_MS;
  }

  const timeoutMs = Number(rawValue);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(
      `Invalid DEV_BACKEND_HEALTHCHECK_TIMEOUT_MS: ${JSON.stringify(rawValue)}`,
    );
  }

  return timeoutMs;
}

export function createFrontendEnv({
  baseEnv,
  backendPort,
  frontendHost,
  frontendPort,
}) {
  const env = createDevChildBaseEnv(baseEnv);
  return {
    ...env,
    VITE_PROXY_TARGET: `http://127.0.0.1:${backendPort}`,
    VITE_STRICT_PORT: "true",
    ...(frontendHost ? { VITE_DEV_HOST: frontendHost } : {}),
    VITE_DEV_PORT: frontendPort,
    VITE_API_BASE_URL: "",
  };
}

const DEFAULT_BACKEND_PORT = 5000;
const DEFAULT_FRONTEND_PORT = 5173;
const DEV_HOST = process.env.DEV_HOST?.trim() || "0.0.0.0";

function canListenOnHost(port, host) {
  return new Promise((resolve) => {
    const tester = net.createServer();

    const cleanup = () => {
      tester.removeAllListeners("error");
      tester.removeAllListeners("listening");
    };

    tester.once("error", (error) => {
      cleanup();

      if (error?.code === "EAFNOSUPPORT" || error?.code === "EADDRNOTAVAIL") {
        resolve("unsupported");
        return;
      }

      resolve(false);
    });

    tester.once("listening", () => {
      tester.close(() => resolve(true));
      cleanup();
    });

    tester.listen({ port, host });
  });
}

async function isPortAvailable(port, host) {
  const result = await canListenOnHost(port, host);
  return result === true;
}

function normalizeProbeHosts(host) {
  return Array.from(
    new Set(
      [host, "0.0.0.0", "127.0.0.1", "::1"].filter(
        (candidate) => typeof candidate === "string" && candidate.trim().length > 0,
      ),
    ),
  );
}

export async function resolvePort(startPort, options = {}) {
  const reservedPorts = options.reservedPorts ?? new Set();
  const hosts = options.hosts ?? normalizeProbeHosts(options.host);
  const isPortAvailableFn = options.isPortAvailable ?? isPortAvailable;
  let port = startPort;
  while (
    reservedPorts.has(port) ||
    !(await Promise.all(hosts.map((host) => isPortAvailableFn(port, host)))).every(
      Boolean,
    )
  ) {
    port += 1;
  }
  return port;
}

export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function spawnManagedProcess(name, args, env) {
  return {
    name,
    child: spawn("pnpm", args, {
      env,
      stdio: "inherit",
    }),
  };
}

export function spawnRawProcess(name, command, args, env) {
  return {
    name,
    child: spawn(command, args, {
      env,
      stdio: "inherit",
    }),
  };
}

export function childHasExited(processInfo) {
  return (
    processInfo.child.exitCode !== null || processInfo.child.signalCode !== null
  );
}

function waitForExit(processInfo) {
  if (childHasExited(processInfo)) {
    return Promise.resolve({
      code: processInfo.child.exitCode,
      signal: processInfo.child.signalCode,
    });
  }

  return new Promise((resolve) => {
    processInfo.child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

export async function stopProcesses(processes) {
  const aliveProcesses = processes.filter(
    (processInfo) => !childHasExited(processInfo),
  );

  for (const processInfo of aliveProcesses) {
    processInfo.child.kill("SIGTERM");
  }

  const exits = Promise.all(
    processes.map((processInfo) => waitForExit(processInfo)),
  );
  const graceful = Symbol("graceful");
  const gracefulOrTimeout = await Promise.race([
    exits.then(() => graceful),
    delay(FORCE_SHUTDOWN_TIMEOUT_MS),
  ]);

  if (gracefulOrTimeout === graceful) {
    return;
  }

  for (const processInfo of processes) {
    if (!childHasExited(processInfo)) {
      processInfo.child.kill("SIGKILL");
    }
  }

  await exits;
}

export async function waitForBackendReady(backend, backendUrl) {
  const healthUrl = `${backendUrl}/health`;
  const healthcheckTimeoutMs = resolveHealthcheckTimeoutMs();
  const deadline = Date.now() + healthcheckTimeoutMs;

  while (Date.now() < deadline) {
    if (childHasExited(backend)) {
      throw new Error(
        `backend exited before becoming ready (code=${backend.child.exitCode}, signal=${backend.child.signalCode})`,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);

    try {
      const response = await fetch(healthUrl, {
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

    await delay(HEALTHCHECK_INTERVAL_MS);
  }

  throw new Error(
    `backend did not become ready within ${healthcheckTimeoutMs}ms: ${healthUrl}`,
  );
}

export function startBackend({ host, backendPort, env }) {
  return spawnManagedProcess(
    "backend",
    [
      "-C",
      "./backend",
      "dev",
      "--",
      "--port",
      String(backendPort),
      "--host",
      host,
    ],
    createBackendEnv({ baseEnv: env, backendPort }),
  );
}

export function startFrontend({ host, backendPort, frontendPort, env }) {
  return spawnManagedProcess(
    "frontend",
    [
      "-C",
      "./frontend",
      "dev",
      "--",
      "--port",
      String(frontendPort),
      "--host",
      host,
    ],
    createFrontendEnv({
      baseEnv: env,
      backendPort,
      frontendPort,
      frontendHost: host,
    }),
  );
}

export function watchProcesses(processes, { logPrefix = "[dev]" } = {}) {
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
      await stopProcesses(processes);
      resolve(exitCode);
    };

    const handleSignal = () => {
      void stopAndResolve(0);
    };

    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);

    for (const processInfo of processes) {
      processInfo.child.on("error", (error) => {
        console.error(`${logPrefix} ${processInfo.name} failed to start`, error);
        void stopAndResolve(1);
      });

      processInfo.child.on("exit", (code) => {
        if (!stopping) {
          void stopAndResolve(code ?? 1);
        }
      });
    }
  }).then((exitCode) => {
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  });
}

export function resolveElectronBin(electronDir) {
  return execFileSync(
    "node",
    ["-e", "process.stdout.write(require('electron'))"],
    { cwd: electronDir, encoding: "utf-8" },
  ).trim();
}

export function bundleElectron(electronDir, env = process.env) {
  execFileSync("node", ["scripts/bundle.mjs"], {
    cwd: electronDir,
    env,
    stdio: "inherit",
  });
}

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
