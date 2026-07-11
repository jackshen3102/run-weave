import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import type { AppServerConnectionInfo } from "@runweave/shared/app-server/types";
import {
  recordLastKnownGoodRuntimeRelease,
  resolveActiveRuntimeRelease,
  resolveBundledRuntimeRelease,
  resolveCurrentRuntimeReleaseId,
  resolveLastKnownGoodRuntimeRelease,
  type RuntimeRelease,
} from "./runtime-release.js";
import type {
  PackagedBackendPaths,
  PackagedBackendRuntime,
  PackagedBackendRuntimeCandidatePlan,
  PackagedBackendRuntimeIncidentEvent,
} from "./backend-runtime-types.js";
import {
  buildPackagedBackendPath,
  preparePackagedNodePtyDir,
  recoverOrphanedPackagedBackendLock,
} from "./backend-runtime-preparation.js";

export type {
  PackagedBackendPaths,
  PackagedBackendRuntime,
  PackagedBackendRuntimeCandidatePlan,
  PackagedBackendRuntimeIncidentEvent,
} from "./backend-runtime-types.js";

const DEFAULT_BACKEND_PORT = 5001;
const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 30_000;
const HEALTHCHECK_INTERVAL_MS = 200;
const LAN_BIND_HOST = "0.0.0.0";
const LOCALHOST_V4 = "127.0.0.1";
const LOCALHOST_V6 = "::1";

export function resolvePackagedBackendPaths(
  resourcesPath: string = process.resourcesPath,
): PackagedBackendPaths {
  const release = resolveBundledRuntimeRelease(resourcesPath);
  return {
    backendEntry: release.backendEntry,
    frontendDistDir: release.frontendDistDir,
    nodePtyDir: release.nodePtyDir,
    releaseId: release.releaseId,
    source: release.source,
  };
}

export function resolvePackagedBackendRuntimeCandidates(options: {
  runtimeRoot: string | null;
  resourcesPath: string;
  shellVersion?: string;
}): PackagedBackendRuntimeCandidatePlan {
  const activeRelease = resolveActiveRuntimeRelease({
    runtimeRoot: options.runtimeRoot,
    resourcesPath: options.resourcesPath,
    shellVersion: options.shellVersion,
  });
  const bundledRelease = resolveBundledRuntimeRelease(options.resourcesPath);
  const candidates: RuntimeRelease[] = [activeRelease];
  const lastKnownGoodRelease = resolveLastKnownGoodRuntimeRelease({
    runtimeRoot: options.runtimeRoot,
    resourcesPath: options.resourcesPath,
    shellVersion: options.shellVersion,
  });
  const currentReleaseId = resolveCurrentRuntimeReleaseId(options.runtimeRoot);
  const currentReleaseInvalid =
    currentReleaseId !== null && activeRelease.source === "bundled";

  if (currentReleaseInvalid && lastKnownGoodRelease) {
    candidates.unshift(lastKnownGoodRelease);
  } else if (
    lastKnownGoodRelease &&
    lastKnownGoodRelease.releaseId !== activeRelease.releaseId
  ) {
    candidates.push(lastKnownGoodRelease);
  }
  if (activeRelease.source !== "bundled") {
    candidates.push(bundledRelease);
  }

  return {
    activeRelease,
    candidates,
    currentReleaseId,
    currentReleaseInvalid,
  };
}

export function buildPackagedBackendEnv(options: {
  baseEnv: NodeJS.ProcessEnv;
  backendPort: number;
  backendPaths: PackagedBackendPaths;
  appServerConnection?: AppServerConnectionInfo | null;
}): NodeJS.ProcessEnv {
  return {
    ...options.baseEnv,
    ELECTRON_RUN_AS_NODE: "1",
    PATH: buildPackagedBackendPath(options.baseEnv.PATH),
    HOST: LAN_BIND_HOST,
    PORT: String(options.backendPort),
    PORT_STRICT: "true",
    FRONTEND_DIST_DIR: options.backendPaths.frontendDistDir,
    RUNWEAVE_RUNTIME_RELEASE_ID: options.backendPaths.releaseId,
    ...(options.appServerConnection
      ? {
          RUNWEAVE_APP_SERVER_URL: options.appServerConnection.baseUrl,
          RUNWEAVE_APP_SERVER_TOKEN: options.appServerConnection.token,
        }
      : {}),
    RUNWEAVE_NODE_PTY_DIR: options.backendPaths.nodePtyDir,
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

async function isBackendPortAvailable(port: number): Promise<boolean> {
  const [lanAvailable, ipv4Available, ipv6Available] = await Promise.all([
    isPortAvailable(port, LAN_BIND_HOST),
    isPortAvailable(port, LOCALHOST_V4),
    isPortAvailable(port, LOCALHOST_V6),
  ]);

  return lanAvailable && ipv4Available && ipv6Available;
}

export async function findAvailablePort(
  startPort: number,
  isAvailable: (port: number) => Promise<boolean> = isBackendPortAvailable,
): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = startPort + attempt;
    if (await isAvailable(port)) {
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
    ensureAppServer?: (
      release: RuntimeRelease,
      env: NodeJS.ProcessEnv,
    ) => Promise<AppServerConnectionInfo | null>;
    onIncidentEvent?: (event: PackagedBackendRuntimeIncidentEvent) => void;
    resourcesPath?: string;
    runtimeRoot?: string | null;
    shellVersion?: string;
  } = {},
): Promise<PackagedBackendRuntime> {
  const baseEnv = options.baseEnv ?? process.env;
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const mergedEnv = buildPackagedBackendEnv({
    baseEnv,
    backendPort: 0,
    backendPaths: resolvePackagedBackendPaths(resourcesPath),
  });
  readRequiredAuthEnv(mergedEnv);

  const candidatePlan = resolvePackagedBackendRuntimeCandidates({
    runtimeRoot: options.runtimeRoot ?? null,
    resourcesPath,
    shellVersion: options.shellVersion,
  });

  const failures: string[] = [];

  for (const release of candidatePlan.candidates) {
    try {
      const runtime = await startPackagedBackendForRelease({
        baseEnv: mergedEnv,
        ensureAppServer: options.ensureAppServer,
        onIncidentEvent: options.onIncidentEvent,
        release,
        runtimeRoot: options.runtimeRoot ?? null,
      });
      runtime.startupWarning =
        failures.length > 0
          ? `Runtime ${candidatePlan.currentReleaseId ?? candidatePlan.activeRelease.releaseId} 启动失败，已回滚到 ${release.releaseId}: ${failures[0]}`
          : candidatePlan.currentReleaseInvalid &&
              candidatePlan.currentReleaseId
            ? `Runtime ${candidatePlan.currentReleaseId} 无效，已回滚到 ${release.releaseId}`
            : null;
      return runtime;
    } catch (error) {
      failures.push(`${release.releaseId}: ${String(error)}`);
    }
  }

  throw new Error(failures.join("; "));
}

async function startPackagedBackendForRelease(options: {
  baseEnv: NodeJS.ProcessEnv;
  ensureAppServer?: (
    release: RuntimeRelease,
    env: NodeJS.ProcessEnv,
  ) => Promise<AppServerConnectionInfo | null>;
  onIncidentEvent?: (event: PackagedBackendRuntimeIncidentEvent) => void;
  release: RuntimeRelease;
  runtimeRoot: string | null;
}): Promise<PackagedBackendRuntime> {
  const release = options.release;
  const nodePtyDir = preparePackagedNodePtyDir({
    nodePtyDir: release.nodePtyDir,
    onIncidentEvent: options.onIncidentEvent,
    release,
    runtimeRoot: options.runtimeRoot,
  });
  const backendPaths: PackagedBackendPaths = {
    backendEntry: release.backendEntry,
    frontendDistDir: release.frontendDistDir,
    nodePtyDir,
    releaseId: release.releaseId,
    source: release.source,
  };
  options.onIncidentEvent?.({
    event: "packagedBackend.candidate.start",
    details: {
      releaseId: release.releaseId,
      source: release.source,
      backendEntry: release.backendEntry,
    },
  });
  await recoverOrphanedPackagedBackendLock(
    options.baseEnv,
    options.onIncidentEvent,
  );
  const backendPort = await findAvailablePort(DEFAULT_BACKEND_PORT);
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const appServerConnection =
    (await options.ensureAppServer?.(release, options.baseEnv)) ?? null;
  const backendEnv = buildPackagedBackendEnv({
    baseEnv: options.baseEnv,
    backendPort,
    backendPaths,
    appServerConnection,
  });

  const child = spawn(process.execPath, [backendPaths.backendEntry], {
    env: backendEnv,
    stdio: "pipe",
  });
  const outputTail: string[] = [];
  const appendOutputTail = (
    stream: "stdout" | "stderr",
    chunk: unknown,
  ): void => {
    const text = String(chunk);
    for (const line of text.split(/\r?\n/)) {
      if (!line) {
        continue;
      }
      outputTail.push(`[${stream}] ${line}`);
      if (outputTail.length > 80) {
        outputTail.shift();
      }
    }
  };

  child.stdout?.on("data", (chunk) => {
    appendOutputTail("stdout", chunk);
    process.stdout.write(String(chunk));
  });
  child.stderr?.on("data", (chunk) => {
    appendOutputTail("stderr", chunk);
    process.stderr.write(String(chunk));
  });

  try {
    await waitForBackendReady(child, backendUrl);
  } catch (error) {
    options.onIncidentEvent?.({
      event: "packagedBackend.candidate.failed",
      level: "error",
      details: {
        releaseId: release.releaseId,
        backendUrl,
        pid: child.pid ?? null,
        error: error instanceof Error ? error.message : String(error),
        outputTail,
      },
    });
    await stopChildProcess(child);
    throw error;
  }

  recordLastKnownGoodRuntimeRelease(release);

  return {
    backendUrl,
    child,
    getOutputTail: () => [...outputTail],
    runtimeRelease: release,
    startupWarning: null,
    stop: async () => {
      await stopChildProcess(child);
    },
  };
}
