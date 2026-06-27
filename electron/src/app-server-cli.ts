import { spawn } from "node:child_process";
import {
  discoverAppServer,
  type AppServerConnectionInfo,
} from "@runweave/shared/src/app-server-node";
import type { RuntimeRelease } from "./runtime-release.js";

export interface AppServerCliLogger {
  info(event: string, details?: Record<string, unknown>): void;
  warn(event: string, details?: Record<string, unknown>): void;
}

export async function ensureAppServerViaCli(options: {
  env: NodeJS.ProcessEnv;
  logger?: AppServerCliLogger;
  release: RuntimeRelease;
}): Promise<AppServerConnectionInfo | null> {
  const existing = await discoverAppServer({ env: options.env });
  if (existing) {
    options.logger?.info("appServer.cli.reuse", {
      baseUrl: existing.baseUrl,
      runtimeReleaseId: options.release.releaseId,
      runtimeSource: options.release.source,
    });
    return existing;
  }

  const result = await runAppServerStartCommand(options);
  if (result.exitCode !== 0) {
    options.logger?.warn("appServer.cli.start.failed", {
      cliEntry: options.release.cliEntry,
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
      runtimeReleaseId: options.release.releaseId,
      runtimeSource: options.release.source,
    });
    return null;
  }

  const connection = await discoverAppServer({ env: options.env });
  if (!connection) {
    options.logger?.warn("appServer.cli.start.unavailable", {
      cliEntry: options.release.cliEntry,
      stdout: result.stdout,
      runtimeReleaseId: options.release.releaseId,
      runtimeSource: options.release.source,
    });
    return null;
  }

  options.logger?.info("appServer.cli.connected", {
    baseUrl: connection.baseUrl,
    runtimeReleaseId: options.release.releaseId,
    runtimeSource: options.release.source,
  });
  return connection;
}

function runAppServerStartCommand(options: {
  env: NodeJS.ProcessEnv;
  release: RuntimeRelease;
}): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [options.release.cliEntry, "app-server", "start"],
      {
        env: {
          ...options.env,
          ELECTRON_RUN_AS_NODE: "1",
          RUNWEAVE_CLI_APP_SERVER_ENTRY: options.release.appServerEntry,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}
