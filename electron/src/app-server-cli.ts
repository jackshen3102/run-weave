import { spawn } from "node:child_process";
import {
  discoverAppServer,
  getAppServerStatus,
  installAppServerRuntimeRelease,
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
  const installedRelease = installAppServerRuntimeRelease({
    entry: options.release.appServerEntry,
    releaseId: `electron-${options.release.releaseId}`,
    env: options.env,
  });
  options.logger?.info("appServer.runtime.installed", {
    entry: installedRelease.entry,
    releaseId: installedRelease.releaseId,
    runtimeRoot: installedRelease.runtimeRoot,
    runtimeReleaseId: options.release.releaseId,
    runtimeSource: options.release.source,
  });

  const status = await getAppServerStatus({ env: options.env });
  const existingIsCurrent =
    status.available && status.lock?.releaseId === installedRelease.releaseId;
  if (existingIsCurrent) {
    const existing = await discoverAppServer({ env: options.env });
    if (!existing) {
      options.logger?.warn("appServer.cli.reuse.unavailable", {
        releaseId: installedRelease.releaseId,
        runtimeReleaseId: options.release.releaseId,
        runtimeSource: options.release.source,
      });
      return null;
    }
    options.logger?.info("appServer.cli.reuse", {
      baseUrl: existing.baseUrl,
      releaseId: installedRelease.releaseId,
      runtimeReleaseId: options.release.releaseId,
      runtimeSource: options.release.source,
    });
    return existing;
  }

  const command = status.available ? "restart" : "start";
  const result = await runAppServerCliCommand(options, command);
  if (result.exitCode !== 0) {
    options.logger?.warn("appServer.cli.command.failed", {
      command,
      cliEntry: options.release.cliEntry,
      exitCode: result.exitCode,
      installedReleaseId: installedRelease.releaseId,
      runningReleaseId: status.lock?.releaseId ?? null,
      stderr: result.stderr,
      stdout: result.stdout,
      runtimeReleaseId: options.release.releaseId,
      runtimeSource: options.release.source,
    });
    return null;
  }

  const connection = await discoverAppServer({ env: options.env });
  if (!connection) {
    options.logger?.warn("appServer.cli.command.unavailable", {
      command,
      cliEntry: options.release.cliEntry,
      installedReleaseId: installedRelease.releaseId,
      stdout: result.stdout,
      runtimeReleaseId: options.release.releaseId,
      runtimeSource: options.release.source,
    });
    return null;
  }

  options.logger?.info("appServer.cli.connected", {
    baseUrl: connection.baseUrl,
    command,
    installedReleaseId: installedRelease.releaseId,
    runtimeReleaseId: options.release.releaseId,
    runtimeSource: options.release.source,
  });
  return connection;
}

function runAppServerCliCommand(
  options: {
    env: NodeJS.ProcessEnv;
    release: RuntimeRelease;
  },
  command: "start" | "restart",
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [options.release.cliEntry, "app-server", command],
      {
        env: {
          ...options.env,
          ELECTRON_RUN_AS_NODE: "1",
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
