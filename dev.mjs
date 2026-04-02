import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const FORCE_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 30_000;
const HEALTHCHECK_INTERVAL_MS = 200;

export function createBackendEnv({ baseEnv, backendPort }) {
  return {
    ...baseEnv,
    BROWSER_DEVTOOLS_ENABLED: baseEnv.BROWSER_DEVTOOLS_ENABLED ?? "true",
    PORT: String(backendPort),
    PORT_STRICT: "true",
    SESSION_RESTORE_ENABLED: baseEnv.SESSION_RESTORE_ENABLED ?? "false",
  };
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
  return {
    ...baseEnv,
    VITE_PROXY_TARGET: `http://localhost:${backendPort}`,
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

export async function resolvePort(startPort, options = {}) {
  const reservedPorts = options.reservedPorts ?? new Set();
  const host = options.host;
  let port = startPort;
  while (reservedPorts.has(port) || !(await isPortAvailable(port, host))) {
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

export function bundleElectron(electronDir) {
  execFileSync("node", ["scripts/bundle.mjs"], {
    cwd: electronDir,
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

  const backendUrl = `http://localhost:${backendPort}`;

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
