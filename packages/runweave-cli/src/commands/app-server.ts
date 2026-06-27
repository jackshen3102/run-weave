import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  discoverAppServer,
  getAppServerStatus,
  installAppServerRuntimeRelease,
  removeStaleAppServerLock,
  resolveAppServerHomeDir,
  resolveAppServerStatePaths,
  resolveCurrentAppServerRuntimeRelease,
  type AppServerConnectionInfo,
  type AppServerRuntimeRelease,
  type AppServerStatus,
} from "@runweave/shared/src/app-server-node";
import { CliError } from "../errors.js";

const START_TIMEOUT_MS = 3_000;
const START_POLL_MS = 100;
const STOP_TIMEOUT_MS = 3_000;

interface AppServerCommandOptions {
  entry: string | null;
  home: string | null;
  releaseId: string | null;
}

export async function runAppServerCommand(
  subcommand: string | undefined,
  args: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const options = parseOptions(args);
  const env = buildScopedEnv(io.env, options);
  const command = subcommand ?? "";

  if (command === "status") {
    writeJson(io.stdout, redactStatus(await getAppServerStatus({ env })));
    return;
  }

  if (command === "install") {
    if (!options.entry) {
      throw new CliError("Usage: rw app-server install --entry <path> [--release-id <id>] [--home <path>]", 2);
    }
    const release = installAppServerRuntimeRelease({
      entry: options.entry,
      releaseId: options.releaseId ?? createReleaseId(),
      env,
    });
    writeJson(io.stdout, {
      installed: true,
      release,
      homeDir: resolveAppServerHomeDir({ env }),
    });
    return;
  }

  if (command === "start") {
    await startAppServer(io.stdout, env);
    return;
  }

  if (command === "stop") {
    await stopAppServer(io.stdout, env);
    return;
  }

  if (command === "restart") {
    await stopAppServer(io.stdout, env, { quiet: true });
    await startAppServer(io.stdout, env);
    return;
  }

  throw new CliError(
    "Usage: rw app-server <status|install|start|stop|restart> [--home <path>]",
    2,
  );
}

async function startAppServer(
  stdout: Pick<NodeJS.WriteStream, "write">,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const runtime = resolveCurrentAppServerRuntimeRelease({ env });
  if (!runtime) {
    const status = await getAppServerStatus({ env });
    writeJson(stdout, {
      started: false,
      error: "Runweave app-server global runtime is not installed",
      ...redactStatus(status),
    });
    throw new CliError("Runweave app-server global runtime is not installed", 1);
  }

  const connection = await ensureAppServerFromCli(env, runtime);
  const status = await getAppServerStatus({ env });
  if (!connection) {
    writeJson(stdout, {
      started: false,
      ...redactStatus(status),
    });
    throw new CliError("Runweave app-server failed to start", 1);
  }
  writeJson(stdout, {
    started: true,
    ...redactStatus(status),
  });
}

async function stopAppServer(
  stdout: Pick<NodeJS.WriteStream, "write">,
  env: NodeJS.ProcessEnv,
  options: { quiet?: boolean } = {},
): Promise<void> {
  const status = await getAppServerStatus({ env });
  if (typeof status.pid !== "number" || !isPidAlive(status.pid)) {
    if (!options.quiet) {
      writeJson(stdout, { stopped: false, ...redactStatus(status) });
    }
    return;
  }

  process.kill(status.pid, "SIGTERM");
  await waitForExit(status.pid, STOP_TIMEOUT_MS);
  const nextStatus = await getAppServerStatus({ env });
  if (!options.quiet) {
    writeJson(stdout, { stopped: true, ...redactStatus(nextStatus) });
  }
}

async function ensureAppServerFromCli(
  env: NodeJS.ProcessEnv,
  runtime: AppServerRuntimeRelease,
): Promise<AppServerConnectionInfo | null> {
  const existing = await discoverAppServer({ env });
  if (existing) {
    return existing;
  }

  await removeStaleAppServerLock({ env });
  await spawnDetachedAppServer(env, runtime);

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const discovered = await discoverAppServer({ env });
    if (discovered) {
      return discovered;
    }
    await delay(START_POLL_MS);
  }
  return null;
}

async function spawnDetachedAppServer(
  env: NodeJS.ProcessEnv,
  runtime: AppServerRuntimeRelease,
): Promise<void> {
  const paths = resolveAppServerStatePaths({ env });
  await mkdir(paths.stateDir, { recursive: true });
  const outputFd = openSync(paths.logPath, "a");
  const child = spawn(process.execPath, [runtime.entry], {
    detached: true,
    env: {
      ...env,
      RUNWEAVE_APP_SERVER_ENTRY: runtime.entry,
      RUNWEAVE_APP_SERVER_RELEASE_ID: runtime.releaseId,
      RUNWEAVE_APP_SERVER_RUNTIME_ROOT: runtime.runtimeRoot ?? "",
      RUNWEAVE_APP_SERVER_SOURCE: runtime.source,
      RUNWEAVE_APP_SERVER_STATE_DIR: paths.stateDir,
    },
    stdio: ["ignore", outputFd, outputFd],
  });
  closeSync(outputFd);
  child.unref();
}

function parseOptions(args: string[]): AppServerCommandOptions {
  const options: AppServerCommandOptions = {
    entry: null,
    home: null,
    releaseId: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === "--entry" || arg === "--home" || arg === "--release-id") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CliError(`${arg} requires a value`, 2);
      }
      if (arg === "--entry") {
        options.entry = path.resolve(value);
      } else if (arg === "--home") {
        options.home = value;
      } else {
        options.releaseId = value;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--entry=")) {
      options.entry = path.resolve(arg.slice("--entry=".length));
      continue;
    }
    if (arg.startsWith("--home=")) {
      options.home = arg.slice("--home=".length);
      continue;
    }
    if (arg.startsWith("--release-id=")) {
      options.releaseId = arg.slice("--release-id=".length);
      continue;
    }
    throw new CliError(`Unknown app-server option: ${arg}`, 2);
  }

  return options;
}

function buildScopedEnv(
  env: NodeJS.ProcessEnv,
  options: AppServerCommandOptions,
): NodeJS.ProcessEnv {
  return {
    ...env,
    ...(options.home ? { RUNWEAVE_APP_SERVER_HOME: options.home } : {}),
    RUNWEAVE_APP_SERVER_URL: undefined,
    RUNWEAVE_APP_SERVER_TOKEN: undefined,
  };
}

function writeJson(
  stdout: Pick<NodeJS.WriteStream, "write">,
  payload: Record<string, unknown>,
): void {
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function redactStatus(status: AppServerStatus): Record<string, unknown> {
  return {
    available: status.available,
    baseUrl: status.baseUrl,
    currentRuntime: status.currentRuntime,
    hasToken: status.hasToken,
    health: status.health,
    lock: status.lock,
    lockPath: status.lockPath,
    pid: status.pid,
    runtimeRoot: status.runtimeRoot,
    stateDir: status.stateDir,
    staleLock: status.staleLock,
    tokenPath: status.tokenPath,
  };
}

function createReleaseId(): string {
  const now = new Date();
  return [
    "local",
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("-");
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return;
    }
    await delay(100);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
