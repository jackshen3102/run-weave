import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";

const DEFAULT_BACKEND_PORT = 5001;
const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 30_000;
const HEALTHCHECK_INTERVAL_MS = 200;
const LOCALHOST = "127.0.0.1";
const DEFAULT_PACKAGED_AUTH = {
  AUTH_USERNAME: "admin",
  AUTH_PASSWORD: "admin",
  AUTH_JWT_SECRET: "browser-viewer-local-jwt-secret",
} as const;

export interface PackagedBackendPaths {
  backendEntry: string;
  nodePtyDir: string;
}

export interface PackagedBackendRuntime {
  backendUrl: string;
  stop(): Promise<void>;
  child: ChildProcess;
}

export function resolvePackagedBackendPaths(
  resourcesPath: string = process.resourcesPath,
): PackagedBackendPaths {
  return {
    backendEntry: path.join(resourcesPath, "app.asar", "dist", "backend", "index.cjs"),
    nodePtyDir: path.join(resourcesPath, "backend", "node_modules", "node-pty"),
  };
}

export function buildPackagedBackendEnv(options: {
  baseEnv: NodeJS.ProcessEnv;
  backendPort: number;
  backendPaths: PackagedBackendPaths;
}): NodeJS.ProcessEnv {
  return {
    ...DEFAULT_PACKAGED_AUTH,
    ...options.baseEnv,
    ELECTRON_RUN_AS_NODE: "1",
    HOST: LOCALHOST,
    PORT: String(options.backendPort),
    PORT_STRICT: "true",
    BROWSER_VIEWER_NODE_PTY_DIR: options.backendPaths.nodePtyDir,
  };
}

function readRequiredAuthEnv(env: NodeJS.ProcessEnv): void {
  for (const name of ["AUTH_USERNAME", "AUTH_PASSWORD", "AUTH_JWT_SECRET"]) {
    if (!env[name]?.trim()) {
      throw new Error(`[electron] missing required backend env: ${name}`);
    }
  }
}

async function isPortAvailable(port: number, host: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const tester = net.createServer();

    const cleanup = (): void => {
      tester.removeAllListeners("error");
      tester.removeAllListeners("listening");
    };

    tester.once("error", () => {
      cleanup();
      resolve(false);
    });

    tester.once("listening", () => {
      tester.close(() => {
        cleanup();
        resolve(true);
      });
    });

    tester.listen(port, host);
  });
}

async function findAvailablePort(
  startPort: number,
  host: string,
): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = startPort + attempt;
    if (await isPortAvailable(port, host)) {
      return port;
    }
  }

  throw new Error(
    `[electron] failed to find available backend port from ${startPort}`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForBackendReady(
  child: ChildProcess,
  backendUrl: string,
): Promise<void> {
  const deadline = Date.now() + DEFAULT_HEALTHCHECK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `[electron] packaged backend exited before ready (code=${child.exitCode}, signal=${child.signalCode})`,
      );
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 500);

      try {
        const response = await fetch(`${backendUrl}/health`, {
          signal: controller.signal,
        });
        if (response.ok) {
          return;
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // Continue polling until timeout.
    }

    await delay(HEALTHCHECK_INTERVAL_MS);
  }

  throw new Error(
    `[electron] packaged backend did not become ready within ${DEFAULT_HEALTHCHECK_TIMEOUT_MS}ms: ${backendUrl}/health`,
  );
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");

  await Promise.race([
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    }),
    delay(5_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

export async function startPackagedBackend(
  options: {
    baseEnv?: NodeJS.ProcessEnv;
  } = {},
): Promise<PackagedBackendRuntime> {
  const baseEnv = options.baseEnv ?? process.env;
  const mergedEnv = buildPackagedBackendEnv({
    baseEnv,
    backendPort: 0,
    backendPaths: resolvePackagedBackendPaths(),
  });
  readRequiredAuthEnv(mergedEnv);

  const backendPaths = resolvePackagedBackendPaths();
  const backendPort = await findAvailablePort(DEFAULT_BACKEND_PORT, LOCALHOST);
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const child = spawn(process.execPath, [backendPaths.backendEntry], {
    env: buildPackagedBackendEnv({
      baseEnv: mergedEnv,
      backendPort,
      backendPaths,
    }),
    stdio: "pipe",
  });

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(String(chunk));
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(String(chunk));
  });

  try {
    await waitForBackendReady(child, backendUrl);
  } catch (error) {
    await stopChildProcess(child);
    throw error;
  }

  return {
    backendUrl,
    child,
    stop: async () => {
      await stopChildProcess(child);
    },
  };
}
