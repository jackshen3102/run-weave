import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PackagedBackendConnectionState } from "@runweave/shared/runtime-monitor";
import {
  startPackagedBackend,
  type PackagedBackendRuntime,
} from "./backend-runtime.js";
import { checkAppServerAvailability } from "./app-server-cli.js";
import { getIsQuitting } from "./app-state.js";
import {
  createAvailablePackagedBackendState,
  createUnavailablePackagedBackendStateFromError,
  createUnavailablePackagedBackendStateFromExit,
} from "./packaged-backend-state.js";
import {
  betaDesktopCdpEndpoint,
  desktopCdpEndpoint,
  desktopChannel,
  desktopSourceRevision,
  isBetaChannel,
  isDev,
} from "./desktop-config.js";
import { desktopRuntime } from "./desktop-runtime-state.js";
import {
  buildDesktopDiagnosticSnapshot,
  getPackagedRuntimeRoot,
  logDesktopIncident,
} from "./desktop-diagnostics.js";
import {
  buildPackagedBackendBaseEnv,
  ensureBetaCliProfile,
  resolvePackagedBackendProfileDir,
} from "./packaged-backend-auth.js";

const desktopProcessStartedAt = new Date().toISOString();

function readDesktopProcessSignature(): string {
  try {
    return execFileSync(
      "/bin/ps",
      ["-p", String(process.pid), "-o", "lstart=", "-o", "command="],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "";
  }
}

export function writeBetaDesktopStatus(stoppedAt: string | null = null): void {
  const explicitStatusPath =
    process.env.RUNWEAVE_DESKTOP_STATUS_PATH?.trim() || null;
  if (!isBetaChannel && !explicitStatusPath) {
    return;
  }

  try {
    const userDataPath = app.getPath("userData");
    const statusPath =
      explicitStatusPath ?? path.join(userDataPath, "beta-desktop-status.json");
    const tempPath = `${statusPath}.tmp`;
    const sharedBackendPid = Number(
      process.env.RUNWEAVE_SHARED_BACKEND_PID ?? "",
    );
    const backendPid =
      desktopRuntime.packagedBackend?.child.pid ??
      (Number.isInteger(sharedBackendPid) ? sharedBackendPid : null);
    const sharedAppServerPid = Number(
      process.env.RUNWEAVE_SHARED_APP_SERVER_PID ?? "",
    );
    const appPath = app.isPackaged
      ? path.resolve(path.dirname(process.execPath), "../..")
      : null;
    mkdirSync(userDataPath, { recursive: true });
    writeFileSync(
      tempPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          channel: desktopChannel,
          instanceId: process.env.RUNWEAVE_DESKTOP_INSTANCE_ID?.trim() || null,
          devSessionId: process.env.RUNWEAVE_DEV_SESSION_ID?.trim() || null,
          sourceRevision: desktopSourceRevision,
          app: {
            executable: process.execPath,
            path: appPath,
            pid: process.pid,
            processSignature: readDesktopProcessSignature(),
            startedAt: desktopProcessStartedAt,
            userDataPath,
            version: app.getVersion(),
          },
          backend: {
            available: stoppedAt
              ? false
              : desktopRuntime.packagedBackendState.available,
            baseUrl: desktopRuntime.packagedBackendState.backendUrl || null,
            pid: stoppedAt ? null : backendPid,
            profileDir:
              process.env.RUNWEAVE_SHARED_BACKEND_PROFILE_DIR ??
              resolvePackagedBackendProfileDir(),
            runtimeReleaseId:
              desktopRuntime.packagedBackendState.runtimeReleaseId,
            runtimeSource: desktopRuntime.packagedBackendState.runtimeSource,
          },
          appServer: {
            baseUrl: process.env.RUNWEAVE_APP_SERVER_URL ?? null,
            home: process.env.RUNWEAVE_APP_SERVER_HOME ?? null,
            lockPath: process.env.RUNWEAVE_SHARED_APP_SERVER_LOCK_PATH ?? null,
            pid:
              Number.isInteger(sharedAppServerPid) && sharedAppServerPid > 0
                ? sharedAppServerPid
                : null,
          },
          cli: {
            configPath: process.env.RUNWEAVE_CONFIG_FILE ?? null,
          },
          cdp: {
            endpoint: stoppedAt
              ? null
              : (desktopCdpEndpoint ?? betaDesktopCdpEndpoint),
            pid: stoppedAt ? null : process.pid,
            desktop: {
              endpoint: stoppedAt ? null : desktopCdpEndpoint,
              pid: stoppedAt ? null : process.pid,
            },
            terminalBrowser: {
              endpoint: stoppedAt
                ? null
                : (desktopRuntime.cdpProxy?.endpoint ?? null),
              pid: stoppedAt ? null : process.pid,
            },
          },
          stoppedAt,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    renameSync(tempPath, statusPath);
  } catch (error) {
    console.warn("[electron] failed to write Beta desktop status", error);
  }
}

export function broadcastPackagedBackendState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(
        "viewer:packaged-backend-state",
        desktopRuntime.packagedBackendState,
      );
    }
  }
}

export function setPackagedBackendState(
  state: PackagedBackendConnectionState,
): PackagedBackendConnectionState {
  desktopRuntime.packagedBackendState = state;
  process.env.RUNWEAVE_BACKEND_URL = state.backendUrl;
  writeBetaDesktopStatus();
  broadcastPackagedBackendState();
  return desktopRuntime.packagedBackendState;
}

export function attachPackagedBackendExitHandler(
  runtime: PackagedBackendRuntime,
): void {
  runtime.child.once("exit", (code, signal) => {
    const expectedExit = desktopRuntime.expectedPackagedBackendExits.has(
      runtime.child,
    );
    desktopRuntime.expectedPackagedBackendExits.delete(runtime.child);

    if (desktopRuntime.packagedBackend?.child === runtime.child) {
      desktopRuntime.packagedBackend = null;
    }

    if (getIsQuitting() || expectedExit) {
      return;
    }

    console.error("[electron] packaged backend exited unexpectedly", {
      code,
      signal,
    });
    desktopRuntime.incidentLogger?.error("packagedBackend.exit.unexpected", {
      code,
      signal,
      backendUrl: runtime.backendUrl,
      pid: runtime.child.pid ?? null,
      outputTail: runtime.getOutputTail(),
      runtimeRelease: runtime.runtimeRelease,
      snapshot: buildDesktopDiagnosticSnapshot(),
    });
    setPackagedBackendState(
      createUnavailablePackagedBackendStateFromExit(runtime.backendUrl, {
        code,
        signal,
      }),
    );

    if (desktopRuntime.mainWindow && !desktopRuntime.mainWindow.isDestroyed()) {
      desktopRuntime.mainWindow.show();
      desktopRuntime.mainWindow.focus();
    }
  });
}

export async function stopPackagedBackendRuntimeForRestart(): Promise<void> {
  if (!desktopRuntime.packagedBackend) {
    return;
  }

  desktopRuntime.expectedPackagedBackendExits.add(
    desktopRuntime.packagedBackend.child,
  );
  const runtime = desktopRuntime.packagedBackend;
  desktopRuntime.packagedBackend = null;
  await runtime.stop();
}

export async function checkAppServerForPackagedBackend(
  env: NodeJS.ProcessEnv,
): Promise<Awaited<ReturnType<typeof checkAppServerAvailability>>> {
  return await checkAndNotifyAppServerAvailability(env);
}

export async function checkAndNotifyAppServerAvailability(
  env: NodeJS.ProcessEnv,
  parentWindow?: BrowserWindow | null,
): Promise<Awaited<ReturnType<typeof checkAppServerAvailability>>> {
  const connection = await checkAppServerAvailability({
    env,
    logger: desktopRuntime.incidentLogger ?? undefined,
  });
  if (connection) {
    desktopRuntime.appServerUnavailableDialogShown = false;
    return connection;
  }

  if (!desktopRuntime.appServerUnavailableDialogShown) {
    showAppServerUnavailableDialog(parentWindow);
  }

  return null;
}

export function showAppServerUnavailableDialog(
  parentWindow?: BrowserWindow | null,
): void {
  desktopRuntime.appServerUnavailableDialogShown = true;
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    buttons: ["OK"],
    title: "App Server",
    message: "App Server 没有启动",
    detail: "Runweave 不会自动安装、启动或重启 App Server。",
  };
  if (parentWindow && !parentWindow.isDestroyed()) {
    parentWindow.show();
    parentWindow.focus();
    setTimeout(() => {
      if (!parentWindow.isDestroyed()) {
        void dialog.showMessageBox(parentWindow, options);
      }
    }, 100);
    return;
  }
  void dialog.showMessageBox(options);
}

export async function startPackagedBackendRuntime(): Promise<PackagedBackendConnectionState> {
  try {
    desktopRuntime.incidentLogger?.info("packagedBackend.start.requested", {
      runtimeRoot: getPackagedRuntimeRoot(),
      resourcesPath: process.resourcesPath,
      shellVersion: app.getVersion(),
      profileDir: resolvePackagedBackendProfileDir(),
    });
    const runtime = await startPackagedBackend({
      baseEnv: buildPackagedBackendBaseEnv(),
      ensureAppServer: async (_release, env) =>
        await checkAppServerForPackagedBackend(env),
      onIncidentEvent: logDesktopIncident,
      runtimeRoot: getPackagedRuntimeRoot(),
      resourcesPath: process.resourcesPath,
      shellVersion: app.getVersion(),
    });

    try {
      await ensureBetaCliProfile(runtime.backendUrl);
    } catch (error) {
      await runtime.stop();
      throw error;
    }

    desktopRuntime.packagedBackend = runtime;
    desktopRuntime.activeRelease = runtime.runtimeRelease;
    attachPackagedBackendExitHandler(runtime);
    desktopRuntime.incidentLogger?.info("packagedBackend.start.succeeded", {
      backendUrl: runtime.backendUrl,
      pid: runtime.child.pid ?? null,
      runtimeRelease: runtime.runtimeRelease,
      startupWarning: runtime.startupWarning,
    });
    return setPackagedBackendState(
      createAvailablePackagedBackendState(runtime.backendUrl, {
        runtimeSource: runtime.runtimeRelease.source,
        runtimeReleaseId: runtime.runtimeRelease.releaseId,
        statusMessage: runtime.startupWarning,
      }),
    );
  } catch (error) {
    console.error("[electron] packaged backend unavailable", error);
    desktopRuntime.incidentLogger?.error("packagedBackend.start.failed", {
      error,
      snapshot: buildDesktopDiagnosticSnapshot(),
    });
    return setPackagedBackendState(
      createUnavailablePackagedBackendStateFromError(
        desktopRuntime.packagedBackendState.backendUrl,
        error,
      ),
    );
  }
}

export async function connectExternalBackendRuntime(): Promise<PackagedBackendConnectionState> {
  const backendUrl = process.env.RUNWEAVE_BACKEND_URL?.trim() || "";
  try {
    const parsed = new URL(backendUrl);
    if (
      parsed.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    ) {
      throw new Error("external Backend URL must be loopback HTTP");
    }
    const response = await fetch(`${backendUrl.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    const health = (await response.json()) as {
      service?: string;
      serviceInstanceId?: string;
      sourceRevision?: string;
      status?: string;
    };
    const expectedId = process.env.RUNWEAVE_EXPECTED_BACKEND_ID?.trim();
    const expectedRevision = process.env.RUNWEAVE_SOURCE_REVISION?.trim();
    if (
      !response.ok ||
      health.status !== "ok" ||
      health.service !== "runweave-backend" ||
      (expectedId && health.serviceInstanceId !== expectedId) ||
      (expectedRevision && health.sourceRevision !== expectedRevision)
    ) {
      throw new Error("external Backend identity handshake failed");
    }
    return setPackagedBackendState(
      createAvailablePackagedBackendState(backendUrl, {
        runtimeSource: "external",
        statusMessage: "Using Dev Session shared Backend",
      }),
    );
  } catch (error) {
    return setPackagedBackendState(
      createUnavailablePackagedBackendStateFromError(backendUrl, error),
    );
  }
}

export async function restartPackagedBackendRuntime(): Promise<PackagedBackendConnectionState> {
  if (desktopRuntime.packagedBackendRestartPromise) {
    return desktopRuntime.packagedBackendRestartPromise;
  }

  desktopRuntime.packagedBackendRestartPromise = (async () => {
    await stopPackagedBackendRuntimeForRestart();
    return await startPackagedBackendRuntime();
  })();

  try {
    return await desktopRuntime.packagedBackendRestartPromise;
  } finally {
    desktopRuntime.packagedBackendRestartPromise = null;
  }
}

export async function reloadLocalRuntime(): Promise<PackagedBackendConnectionState> {
  if (isDev) {
    return desktopRuntime.packagedBackendState;
  }

  const state = await restartPackagedBackendRuntime();
  if (!state.available) {
    dialog.showErrorBox(
      "Reload Local Runtime Failed",
      state.statusMessage ?? "Local runtime reload failed.",
    );
    return state;
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.reloadIgnoringCache();
    }
  }

  if (state.statusMessage) {
    dialog.showMessageBox({
      type: "warning",
      title: "Local Runtime Rolled Back",
      message: state.statusMessage,
    });
  }

  return state;
}

export function registerPackagedBackendHandlers(): void {
  ipcMain.handle(
    "viewer:get-packaged-backend-state",
    async (): Promise<PackagedBackendConnectionState> => {
      return desktopRuntime.packagedBackendState;
    },
  );

  ipcMain.handle(
    "viewer:restart-packaged-backend",
    async (): Promise<PackagedBackendConnectionState> => {
      if (isDev) {
        return desktopRuntime.packagedBackendState;
      }

      return await restartPackagedBackendRuntime();
    },
  );

  ipcMain.handle(
    "viewer:reload-runtime",
    async (): Promise<PackagedBackendConnectionState> => {
      return await reloadLocalRuntime();
    },
  );

  ipcMain.handle("viewer:check-app-server", async (event): Promise<boolean> => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    return (
      (await checkAndNotifyAppServerAvailability(process.env, parentWindow)) !==
      null
    );
  });
}
