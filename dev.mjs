import net from "node:net";
import os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const FORCE_SHUTDOWN_TIMEOUT_MS = 5_000;
const HEALTHCHECK_TIMEOUT_MS = 15_000;
const HEALTHCHECK_INTERVAL_MS = 200;

export function createBackendEnv({ baseEnv, backendPort }) {
  return {
    ...baseEnv,
    PORT: String(backendPort),
    PORT_STRICT: "true",
  };
}

export function createFrontendEnv({ baseEnv, backendPort, frontendHost }) {
  return {
    ...baseEnv,
    VITE_PROXY_TARGET: `http://localhost:${backendPort}`,
    VITE_STRICT_PORT: "true",
    ...(frontendHost ? { VITE_DEV_HOST: frontendHost } : {}),
    VITE_API_BASE_URL: "",
  };
}

const DEFAULT_BACKEND_PORT = 5000;
const DEFAULT_FRONTEND_PORT = 5173;
const DEV_HOST = process.env.DEV_HOST?.trim() || "0.0.0.0";

function resolveLanAddress() {
  const interfaces = os.networkInterfaces();

  for (const values of Object.values(interfaces)) {
    if (!values) {
      continue;
    }

    for (const info of values) {
      if (info.family === "IPv4" && !info.internal) {
        return info.address;
      }
    }
  }

  return undefined;
}

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

async function resolvePort(startPort, options = {}) {
  const reservedPorts = options.reservedPorts ?? new Set();
  const host = options.host;
  let port = startPort;
  while (reservedPorts.has(port) || !(await isPortAvailable(port, host))) {
    port += 1;
  }
  return port;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function spawnManagedProcess(name, args, env) {
  return {
    name,
    child: spawn("pnpm", args, {
      env,
      stdio: "inherit",
    }),
  };
}

function childHasExited(processInfo) {
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

async function stopProcesses(processes) {
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

async function waitForBackendReady(backend, backendUrl) {
  const healthUrl = `${backendUrl}/health`;
  const deadline = Date.now() + HEALTHCHECK_TIMEOUT_MS;

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
    `backend did not become ready within ${HEALTHCHECK_TIMEOUT_MS}ms: ${healthUrl}`,
  );
}

async function run() {
  const reservedPorts = new Set();

  const backendPort = await resolvePort(DEFAULT_BACKEND_PORT, {
    reservedPorts,
    host: DEV_HOST,
  });
  reservedPorts.add(backendPort);

  if (backendPort !== DEFAULT_BACKEND_PORT) {
    console.log(
      `[dev] backend preferred port ${DEFAULT_BACKEND_PORT} unavailable, using ${backendPort}`,
    );
  }

  const backend = spawnManagedProcess(
    "backend",
    [
      "-C",
      "./backend",
      "dev",
      "--",
      "--port",
      String(backendPort),
      "--host",
      DEV_HOST,
    ],
    createBackendEnv({
      baseEnv: process.env,
      backendPort,
    }),
  );

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

  if (frontendPort !== DEFAULT_FRONTEND_PORT) {
    console.log(
      `[dev] frontend preferred port ${DEFAULT_FRONTEND_PORT} unavailable, using ${frontendPort}`,
    );
  }

  const frontend = spawnManagedProcess(
    "frontend",
    [
      "-C",
      "./frontend",
      "dev",
      "--",
      "--port",
      String(frontendPort),
      "--host",
      DEV_HOST,
    ],
    createFrontendEnv({
      baseEnv: process.env,
      backendPort,
      frontendHost: DEV_HOST,
    }),
  );

  const processes = [backend, frontend];

  const lanAddress = resolveLanAddress();

  console.log(
    `[dev] frontend: http://localhost:${frontendPort} | backend: ${backendUrl}`,
  );
  if (lanAddress) {
    console.log(
      `[dev] network:  http://${lanAddress}:${frontendPort} | backend: http://${lanAddress}:${backendPort}`,
    );
  }

  await new Promise((resolve) => {
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

    const handleExit = (processInfo, code, signal) => {
      if (stopping) {
        return;
      }

      console.log(`[dev] ${processInfo.name} exited`, { code, signal });
      void stopAndResolve(code ?? 1);
    };

    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);

    for (const processInfo of processes) {
      processInfo.child.on("error", (error) => {
        console.error(`[dev] ${processInfo.name} failed to start`, error);
        void stopAndResolve(1);
      });

      processInfo.child.on("exit", (code, signal) => {
        handleExit(processInfo, code, signal);
      });
    }
  }).then((exitCode) => {
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  });
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
