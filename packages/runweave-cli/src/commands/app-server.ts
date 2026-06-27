import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  discoverAppServer,
  getAppServerStatus,
  removeStaleAppServerLock,
  resolveAppServerStatePaths,
  type AppServerConnectionInfo,
  type AppServerStatus,
} from "@runweave/shared/src/app-server-node";
import { CliError } from "../errors.js";

const START_TIMEOUT_MS = 3_000;
const START_POLL_MS = 100;

export async function runAppServerCommand(
  subcommand: string | undefined,
  args: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  if ((subcommand !== "status" && subcommand !== "start") || args.length > 0) {
    throw new CliError("Usage: rw app-server <status|start>", 2);
  }

  if (subcommand === "status") {
    writeJson(io.stdout, redactStatus(await getAppServerStatus({ env: io.env })));
    return;
  }

  const connection = await ensureAppServerFromCli(io.env);
  const status = await getAppServerStatus({ env: io.env });
  if (!connection) {
    writeJson(io.stdout, {
      started: false,
      ...redactStatus(status),
    });
    throw new CliError("Runweave app-server failed to start", 1);
  }
  writeJson(io.stdout, {
    started: true,
    ...redactStatus(status),
  });
}

async function ensureAppServerFromCli(
  env: NodeJS.ProcessEnv,
): Promise<AppServerConnectionInfo | null> {
  const existing = await discoverAppServer({ env });
  if (existing) {
    return existing;
  }

  await removeStaleAppServerLock({ env });
  await spawnDetachedAppServer(env);

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

async function spawnDetachedAppServer(env: NodeJS.ProcessEnv): Promise<void> {
  const entry = resolveAppServerEntry(env);
  if (!entry) {
    throw new CliError("Runweave app-server executable is missing", 1);
  }

  const paths = resolveAppServerStatePaths({ env });
  await mkdir(paths.stateDir, { recursive: true });
  const outputFd = openSync(paths.logPath, "a");
  const child = spawn(process.execPath, [entry], {
    detached: true,
    env: {
      ...env,
      RUNWEAVE_APP_SERVER_STATE_DIR: paths.stateDir,
    },
    stdio: ["ignore", outputFd, outputFd],
  });
  closeSync(outputFd);
  child.unref();
}

function resolveAppServerEntry(env: NodeJS.ProcessEnv): string | null {
  const explicitEntry = env.RUNWEAVE_CLI_APP_SERVER_ENTRY?.trim();
  if (explicitEntry) {
    return explicitEntry;
  }

  const candidates = [
    path.join(__dirname, "..", "app-server", "index.js"),
    path.join(__dirname, "..", "app-server", "index.cjs"),
    path.join(__dirname, "app-server", "index.js"),
    path.join(__dirname, "app-server", "index.cjs"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
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
    hasToken: status.hasToken,
    health: status.health,
    lock: status.lock,
    lockPath: status.lockPath,
    pid: status.pid,
    stateDir: status.stateDir,
    staleLock: status.staleLock,
    tokenPath: status.tokenPath,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
