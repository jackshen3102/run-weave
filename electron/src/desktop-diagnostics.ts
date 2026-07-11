import { app, dialog, shell } from "electron";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BROWSER_PROFILE_LOCK_FILE_NAME,
  getBrowserProfileLockFile,
  resolveDefaultBrowserProfileDir,
  resolveBrowserProfileRootDir,
  resolveLegacyBrowserProfileRootDir,
} from "@runweave/shared/browser-profile-node";
import type { PackagedBackendRuntimeIncidentEvent } from "./backend-runtime.js";
import { DesktopIncidentLogger } from "./desktop-incident-logger.js";
import {
  resolveActiveRuntimeRelease,
  resolveRuntimeRoot,
  type RuntimeRelease,
} from "./runtime-release.js";
import { DEV_RENDERER_DIST, isDev } from "./desktop-config.js";
import { desktopRuntime } from "./desktop-runtime-state.js";
import { resolvePackagedBackendProfileDir } from "./packaged-backend-auth.js";

export function logDesktopIncident(
  event: PackagedBackendRuntimeIncidentEvent,
): void {
  if (!desktopRuntime.incidentLogger) {
    return;
  }

  const level = event.level ?? "info";
  if (level === "error") {
    desktopRuntime.incidentLogger.error(event.event, event.details);
  } else if (level === "warn") {
    desktopRuntime.incidentLogger.warn(event.event, event.details);
  } else {
    desktopRuntime.incidentLogger.info(event.event, event.details);
  }
}

export function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export function collectBackendLockSnapshots(): Array<Record<string, unknown>> {
  const snapshots: Array<Record<string, unknown>> = [];
  const profileRoots = [
    resolveBrowserProfileRootDir(os.homedir()),
    resolveLegacyBrowserProfileRootDir(os.homedir()),
  ];
  for (const profileRoot of profileRoots) {
    if (!existsSync(profileRoot)) {
      continue;
    }
    for (const entry of readdirSync(profileRoot).slice(0, 50)) {
      const profileDir = path.join(profileRoot, entry);
      const lockFile = getBrowserProfileLockFile(profileDir);
      if (!existsSync(lockFile)) {
        continue;
      }
      snapshots.push({
        profileRoot,
        profileDir,
        lockFile,
        owner: readJsonFile(lockFile),
      });
    }
  }
  return snapshots;
}

export function buildDesktopDiagnosticSnapshot(): Record<string, unknown> {
  const runtimeRoot = getPackagedRuntimeRoot();
  return {
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    isDev,
    pid: process.pid,
    cwd: process.cwd(),
    userDataPath: app.getPath("userData"),
    logsPath: app.getPath("logs"),
    resourcesPath: process.resourcesPath,
    backendState: desktopRuntime.packagedBackendState,
    packagedBackendPid: desktopRuntime.packagedBackend?.child.pid ?? null,
    packagedBackendExitCode:
      desktopRuntime.packagedBackend?.child.exitCode ?? null,
    packagedBackendSignalCode:
      desktopRuntime.packagedBackend?.child.signalCode ?? null,
    cdpProxyEndpoint: desktopRuntime.cdpProxy?.endpoint ?? null,
    runtimeRoot,
    currentRuntime: runtimeRoot
      ? readJsonFile(path.join(runtimeRoot, "current.json"))
      : null,
    lastKnownGoodRuntime: runtimeRoot
      ? readJsonFile(path.join(runtimeRoot, "last-known-good.json"))
      : null,
    defaultBackendProfileDir: resolveDefaultBrowserProfileDir(
      process.cwd(),
      os.homedir(),
    ),
    packagedBackendProfileDir: resolvePackagedBackendProfileDir(),
    backendProfileLockFileName: BROWSER_PROFILE_LOCK_FILE_NAME,
    backendLocks: collectBackendLockSnapshots(),
  };
}

export function initializeDesktopIncidentLogger(): void {
  try {
    desktopRuntime.incidentLogger = new DesktopIncidentLogger({
      appName: app.getName(),
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      logsPath: app.getPath("logs"),
      userDataPath: app.getPath("userData"),
      resourcesPath: process.resourcesPath,
    });
    desktopRuntime.incidentLogger.recordLaunch();
    desktopRuntime.incidentLogger.recordNewCrashReports();
  } catch (error) {
    desktopRuntime.incidentLogger = null;
    console.warn(
      "[electron] failed to initialize desktop incident logger",
      error,
    );
  }
}

export function exportDesktopDiagnostics(): void {
  if (!desktopRuntime.incidentLogger) {
    dialog.showErrorBox(
      "Export Desktop Diagnostics Failed",
      "Desktop incident logger is not available.",
    );
    return;
  }

  try {
    const result = desktopRuntime.incidentLogger.exportDiagnosticPackage({
      snapshot: buildDesktopDiagnosticSnapshot(),
    });
    shell.showItemInFolder(result.summaryFile);
    void dialog.showMessageBox({
      type: "info",
      title: "Desktop Diagnostics Exported",
      message: "Desktop diagnostics package exported.",
      detail: result.directory,
    });
  } catch (error) {
    desktopRuntime.incidentLogger.error("desktop.diagnostics.exportFailed", {
      error,
    });
    dialog.showErrorBox("Export Desktop Diagnostics Failed", String(error));
  }
}

export function getPackagedRuntimeRoot(): string | null {
  if (isDev) {
    return null;
  }

  return resolveRuntimeRoot(app.getPath("userData"));
}

export function refreshActiveRuntimeRelease(): RuntimeRelease {
  desktopRuntime.activeRelease = resolveActiveRuntimeRelease({
    runtimeRoot: getPackagedRuntimeRoot(),
    resourcesPath: process.resourcesPath,
    shellVersion: app.getVersion(),
  });
  return desktopRuntime.activeRelease;
}

export function getActiveFrontendDistDir(): string {
  if (isDev) {
    return DEV_RENDERER_DIST;
  }

  return (desktopRuntime.activeRelease ?? refreshActiveRuntimeRelease())
    .frontendDistDir;
}
