import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  protocol,
  net,
  nativeImage,
} from "electron";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import pidusage from "pidusage";
import path from "node:path";
import type {
  PackagedBackendConnectionState,
  RuntimeStatsSnapshot,
  SystemMonitorSnapshot,
  TerminalBrowserCdpProxyInfo,
} from "@runweave/shared";
import {
  BROWSER_PROFILE_LOCK_FILE_NAME,
  getBrowserProfileLockFile,
  resolveBrowserProfileDir,
} from "@runweave/shared/src/browser-profile-node";
import { resolveProtocolFilePath } from "./protocol-path.js";
import {
  startCdpProxy,
  type CdpProxyRuntime,
} from "./terminal-browser-cdp-proxy.js";
import {
  resolveCdpProxyPort,
  findAvailableCdpProxyPort,
  CDP_PROXY_HOST,
} from "./terminal-browser-cdp-proxy-port.js";
import {
  startPackagedBackend,
  type PackagedBackendRuntimeIncidentEvent,
  type PackagedBackendRuntime,
} from "./backend-runtime.js";
import { DesktopIncidentLogger } from "./desktop-incident-logger.js";
import {
  resolveActiveRuntimeRelease,
  resolveRuntimeRoot,
  type RuntimeRelease,
} from "./runtime-release.js";
import { createTray } from "./tray.js";
import { initAutoUpdater, checkForUpdates } from "./updater.js";
import { getIsQuitting, setIsQuitting } from "./app-state.js";
import { shouldEnableAutoUpdates } from "./updater-config.js";
import {
  buildRuntimeStatsSnapshot,
  type ElectronProcessMetric,
} from "./runtime-monitor.js";
import { buildSystemMonitorSnapshot } from "./system-monitor.js";
import {
  createAvailablePackagedBackendState,
  createUnavailablePackagedBackendStateFromError,
  createUnavailablePackagedBackendStateFromExit,
} from "./packaged-backend-state.js";
import { buildApplicationMenuTemplate } from "./application-menu.js";
import { shouldAutoOpenWindowDevtools } from "./window-devtools.js";
import {
  closeTerminalBrowsersForWindow,
  registerTerminalBrowserHandlers,
  getTerminalBrowserEntryByTargetId,
  getTerminalBrowserCdpTargets,
} from "./terminal-browser-view.js";
import { installHooksIfNeeded } from "./hooks/hook-installer.js";

const isDev = !app.isPackaged;
process.env.BROWSER_VIEWER_MANAGES_PACKAGED_BACKEND = isDev ? "false" : "true";

const DEV_SERVER_URL =
  process.env.BROWSER_VIEWER_DEV_URL ?? "http://localhost:5173";

const DEV_RENDERER_DIST = path.join(__dirname, "../../frontend/dist");
const PRELOAD_PATH = path.join(__dirname, "preload.cjs");
const DEV_DOCK_ICON_PATH = path.join(
  __dirname,
  "../resources/icons/icon-preview.png",
);

const CUSTOM_PROTOCOL = "browser-viewer";

protocol.registerSchemesAsPrivileged([
  {
    scheme: CUSTOM_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function registerCustomProtocol(getFrontendDistDir: () => string) {
  protocol.handle(CUSTOM_PROTOCOL, (request) => {
    const resolved = resolveProtocolFilePath(request.url, getFrontendDistDir());

    if (resolved.status === "forbidden") {
      return new Response("Forbidden", { status: 403 });
    }

    return net.fetch(`file://${resolved.filePath}`);
  });
}

function registerOpenExternalHandler(): void {
  ipcMain.handle("viewer:open-external", async (_event, url: string) => {
    if (typeof url !== "string") {
      return;
    }

    try {
      const parsed = new URL(url);
      if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) {
        return;
      }
      await shell.openExternal(url);
    } catch {
      return;
    }
  });
}

function registerRuntimeStatsHandler(
  getPackagedBackendRuntime: () => PackagedBackendRuntime | null,
): void {
  ipcMain.handle(
    "viewer:get-runtime-stats",
    async (): Promise<RuntimeStatsSnapshot> => {
      const packagedBackendRuntime = getPackagedBackendRuntime();
      const backendPid =
        typeof packagedBackendRuntime?.child.pid === "number"
          ? packagedBackendRuntime.child.pid
          : null;

      let backendUsage: { cpu: number; memory: number } | null = null;
      if (backendPid !== null) {
        try {
          const usage = await pidusage(backendPid);
          backendUsage = {
            cpu: usage.cpu,
            memory: usage.memory,
          };
        } catch {
          backendUsage = null;
        }
      }

      return buildRuntimeStatsSnapshot({
        sampledAt: Date.now(),
        processMetrics: app.getAppMetrics() as ElectronProcessMetric[],
        backendPid,
        backendUsage,
      });
    },
  );
}

function registerSystemMonitorHandler(
  getPackagedBackendRuntime: () => PackagedBackendRuntime | null,
): void {
  ipcMain.handle(
    "system-monitor:get",
    async (event): Promise<SystemMonitorSnapshot> => {
      if (!isSystemMonitorSenderAllowed(event.senderFrame?.url ?? "")) {
        throw new Error("System Monitor is only available from the local app.");
      }

      const electronProcessIds = app
        .getAppMetrics()
        .map((metric) => metric.pid)
        .filter((pid): pid is number => typeof pid === "number");
      const backendPid = getPackagedBackendRuntime()?.child.pid;
      const currentProcessIds =
        typeof backendPid === "number"
          ? [...electronProcessIds, backendPid]
          : electronProcessIds;

      return await buildSystemMonitorSnapshot({ currentProcessIds });
    },
  );
}

function isSystemMonitorSenderAllowed(senderUrl: string): boolean {
  try {
    const parsed = new URL(senderUrl);
    if (isDev) {
      const devUrl = new URL(DEV_SERVER_URL);
      if (parsed.origin !== devUrl.origin) {
        return false;
      }
    } else if (parsed.protocol !== `${CUSTOM_PROTOCOL}:`) {
      return false;
    }

    return parsed.pathname === "/system-monitor";
  } catch {
    return false;
  }
}

function createWindow(options?: {
  hideOnClose?: boolean;
  initialPath?: string;
}): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: "default",
    show: false,
  });

  win.once("ready-to-show", () => {
    win.show();
  });
  win.once("closed", () => {
    closeTerminalBrowsersForWindow(win.id);
  });

  if (isDev) {
    win.loadURL(`${DEV_SERVER_URL}${options?.initialPath ?? ""}`);
    if (shouldAutoOpenWindowDevtools({ isDev })) {
      win.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    win.loadURL(`${CUSTOM_PROTOCOL}://app/index.html`);
    if (options?.initialPath) {
      win.webContents.once("did-finish-load", () => {
        navigateWindowToPath(win, options.initialPath ?? "/");
      });
    }
  }

  setupSessionIntercept(win);

  if (options?.hideOnClose) {
    win.on("close", (event) => {
      if (!getIsQuitting()) {
        event.preventDefault();
        win.hide();
      }
    });
  }

  return win;
}

function navigateWindowToPath(win: BrowserWindow, routePath: string): void {
  if (win.isDestroyed()) {
    return;
  }

  if (isDev) {
    void win.loadURL(`${DEV_SERVER_URL}${routePath}`);
    return;
  }

  const serializedPath = JSON.stringify(routePath);
  void win.webContents
    .executeJavaScript(
      `window.history.pushState(null, "", ${serializedPath}); window.dispatchEvent(new PopStateEvent("popstate"));`,
    )
    .catch(() => {
      if (win.isDestroyed()) {
        return;
      }
      void win.loadURL(`${CUSTOM_PROTOCOL}://app/index.html`).then(() => {
        navigateWindowToPath(win, routePath);
      });
    });
}

function setApplicationIcon(): void {
  if (process.platform !== "darwin") {
    return;
  }

  const icon = nativeImage.createFromPath(DEV_DOCK_ICON_PATH);
  if (icon.isEmpty()) {
    return;
  }

  app.dock.setIcon(icon);
}

function isBackendRequest(url: string): boolean {
  try {
    const parsed = new URL(url);
    const p = parsed.pathname;
    return (
      p.startsWith("/api/") ||
      p.startsWith("/ws/") ||
      p.startsWith("/ws?") ||
      p === "/health"
    );
  } catch {
    return false;
  }
}

function setupSessionIntercept(win: BrowserWindow) {
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const headers: Record<string, string[]> = { ...details.responseHeaders };

    delete headers["content-security-policy"];
    delete headers["Content-Security-Policy"];

    if (isBackendRequest(details.url)) {
      headers["Access-Control-Allow-Origin"] = ["*"];
      headers["Access-Control-Allow-Methods"] = [
        "GET, POST, DELETE, PATCH, PUT, OPTIONS",
      ];
      headers["Access-Control-Allow-Headers"] = [
        "Content-Type, Authorization, X-Auth-Client, X-Connection-Id",
      ];
    }

    callback({ responseHeaders: headers });
  });
}

app.commandLine.appendSwitch("ignore-certificate-errors");

let packagedBackendRuntime: PackagedBackendRuntime | null = null;
let cdpProxyRuntime: CdpProxyRuntime | null = null;
let mainWindow: BrowserWindow | null = null;
let activeRuntimeRelease: RuntimeRelease | null = null;
let packagedBackendState: PackagedBackendConnectionState = {
  kind: "packaged-local",
  available: false,
  backendUrl: process.env.BROWSER_VIEWER_BACKEND_URL ?? "",
  statusMessage: null,
  canReconnect: true,
  runtimeSource: null,
  runtimeReleaseId: null,
};
let packagedBackendRestartPromise: Promise<PackagedBackendConnectionState> | null =
  null;
const expectedPackagedBackendExits = new WeakSet<object>();
let packagedBackendsStoppedForQuit = false;
let stoppingPackagedBackendsForQuit = false;
let desktopIncidentLogger: DesktopIncidentLogger | null = null;

function logDesktopIncident(event: PackagedBackendRuntimeIncidentEvent): void {
  if (!desktopIncidentLogger) {
    return;
  }

  const level = event.level ?? "info";
  if (level === "error") {
    desktopIncidentLogger.error(event.event, event.details);
  } else if (level === "warn") {
    desktopIncidentLogger.warn(event.event, event.details);
  } else {
    desktopIncidentLogger.info(event.event, event.details);
  }
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function collectBackendLockSnapshots(): Array<Record<string, unknown>> {
  const profileRoot = path.join(os.homedir(), ".browser-profile");
  if (!existsSync(profileRoot)) {
    return [];
  }

  const snapshots: Array<Record<string, unknown>> = [];
  for (const entry of readdirSync(profileRoot).slice(0, 50)) {
    const profileDir = path.join(profileRoot, entry);
    const lockFile = getBrowserProfileLockFile(profileDir);
    if (!existsSync(lockFile)) {
      continue;
    }
    snapshots.push({
      profileDir,
      lockFile,
      owner: readJsonFile(lockFile),
    });
  }
  return snapshots;
}

function buildDesktopDiagnosticSnapshot(): Record<string, unknown> {
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
    backendState: packagedBackendState,
    packagedBackendPid: packagedBackendRuntime?.child.pid ?? null,
    packagedBackendExitCode: packagedBackendRuntime?.child.exitCode ?? null,
    packagedBackendSignalCode: packagedBackendRuntime?.child.signalCode ?? null,
    cdpProxyEndpoint: cdpProxyRuntime?.endpoint ?? null,
    runtimeRoot,
    currentRuntime: runtimeRoot
      ? readJsonFile(path.join(runtimeRoot, "current.json"))
      : null,
    lastKnownGoodRuntime: runtimeRoot
      ? readJsonFile(path.join(runtimeRoot, "last-known-good.json"))
      : null,
    defaultBackendProfileDir: resolveBrowserProfileDir(process.env),
    backendProfileLockFileName: BROWSER_PROFILE_LOCK_FILE_NAME,
    backendLocks: collectBackendLockSnapshots(),
  };
}

function initializeDesktopIncidentLogger(): void {
  try {
    desktopIncidentLogger = new DesktopIncidentLogger({
      appName: app.getName(),
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      logsPath: app.getPath("logs"),
      userDataPath: app.getPath("userData"),
      resourcesPath: process.resourcesPath,
    });
    desktopIncidentLogger.recordLaunch();
    desktopIncidentLogger.recordNewCrashReports();
  } catch (error) {
    desktopIncidentLogger = null;
    console.warn(
      "[electron] failed to initialize desktop incident logger",
      error,
    );
  }
}

function exportDesktopDiagnostics(): void {
  if (!desktopIncidentLogger) {
    dialog.showErrorBox(
      "Export Desktop Diagnostics Failed",
      "Desktop incident logger is not available.",
    );
    return;
  }

  try {
    const result = desktopIncidentLogger.exportDiagnosticPackage({
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
    desktopIncidentLogger.error("desktop.diagnostics.exportFailed", { error });
    dialog.showErrorBox("Export Desktop Diagnostics Failed", String(error));
  }
}

function getPackagedRuntimeRoot(): string | null {
  if (isDev) {
    return null;
  }

  return resolveRuntimeRoot(app.getPath("userData"));
}

function refreshActiveRuntimeRelease(): RuntimeRelease {
  activeRuntimeRelease = resolveActiveRuntimeRelease({
    runtimeRoot: getPackagedRuntimeRoot(),
    resourcesPath: process.resourcesPath,
    shellVersion: app.getVersion(),
  });
  return activeRuntimeRelease;
}

function getActiveFrontendDistDir(): string {
  if (isDev) {
    return DEV_RENDERER_DIST;
  }

  return (activeRuntimeRelease ?? refreshActiveRuntimeRelease())
    .frontendDistDir;
}

function broadcastPackagedBackendState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(
        "viewer:packaged-backend-state",
        packagedBackendState,
      );
    }
  }
}

function setPackagedBackendState(
  state: PackagedBackendConnectionState,
): PackagedBackendConnectionState {
  packagedBackendState = state;
  process.env.BROWSER_VIEWER_BACKEND_URL = state.backendUrl;
  broadcastPackagedBackendState();
  return packagedBackendState;
}

function attachPackagedBackendExitHandler(
  runtime: PackagedBackendRuntime,
): void {
  runtime.child.once("exit", (code, signal) => {
    const expectedExit = expectedPackagedBackendExits.has(runtime.child);
    expectedPackagedBackendExits.delete(runtime.child);

    if (packagedBackendRuntime?.child === runtime.child) {
      packagedBackendRuntime = null;
    }

    if (getIsQuitting() || expectedExit) {
      return;
    }

    console.error("[electron] packaged backend exited unexpectedly", {
      code,
      signal,
    });
    desktopIncidentLogger?.error("packagedBackend.exit.unexpected", {
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

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

async function stopPackagedBackendRuntimeForRestart(): Promise<void> {
  if (!packagedBackendRuntime) {
    return;
  }

  expectedPackagedBackendExits.add(packagedBackendRuntime.child);
  const runtime = packagedBackendRuntime;
  packagedBackendRuntime = null;
  await runtime.stop();
}

async function startPackagedBackendRuntime(): Promise<PackagedBackendConnectionState> {
  try {
    desktopIncidentLogger?.info("packagedBackend.start.requested", {
      runtimeRoot: getPackagedRuntimeRoot(),
      resourcesPath: process.resourcesPath,
      shellVersion: app.getVersion(),
    });
    const runtime = await startPackagedBackend({
      baseEnv: process.env,
      onIncidentEvent: logDesktopIncident,
      runtimeRoot: getPackagedRuntimeRoot(),
      resourcesPath: process.resourcesPath,
      shellVersion: app.getVersion(),
    });

    packagedBackendRuntime = runtime;
    activeRuntimeRelease = runtime.runtimeRelease;
    attachPackagedBackendExitHandler(runtime);
    desktopIncidentLogger?.info("packagedBackend.start.succeeded", {
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
    desktopIncidentLogger?.error("packagedBackend.start.failed", {
      error,
      snapshot: buildDesktopDiagnosticSnapshot(),
    });
    return setPackagedBackendState(
      createUnavailablePackagedBackendStateFromError(
        packagedBackendState.backendUrl,
        error,
      ),
    );
  }
}

async function restartPackagedBackendRuntime(): Promise<PackagedBackendConnectionState> {
  if (packagedBackendRestartPromise) {
    return packagedBackendRestartPromise;
  }

  packagedBackendRestartPromise = (async () => {
    await stopPackagedBackendRuntimeForRestart();
    return await startPackagedBackendRuntime();
  })();

  try {
    return await packagedBackendRestartPromise;
  } finally {
    packagedBackendRestartPromise = null;
  }
}

async function reloadLocalRuntime(): Promise<PackagedBackendConnectionState> {
  if (isDev) {
    return packagedBackendState;
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

function registerPackagedBackendHandlers(): void {
  ipcMain.handle(
    "viewer:get-packaged-backend-state",
    async (): Promise<PackagedBackendConnectionState> => {
      return packagedBackendState;
    },
  );

  ipcMain.handle(
    "viewer:restart-packaged-backend",
    async (): Promise<PackagedBackendConnectionState> => {
      if (isDev) {
        return packagedBackendState;
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
}

function registerCdpProxyHandlers(): void {
  ipcMain.handle(
    "terminal-browser:get-cdp-proxy-info",
    (_event, tabId: string): TerminalBrowserCdpProxyInfo => {
      const proxy = cdpProxyRuntime;
      const targets = getTerminalBrowserCdpTargets();
      const match = targets.find((t) => t.key.endsWith(`:${tabId}`));
      const found = match
        ? getTerminalBrowserEntryByTargetId(match.targetId)
        : null;

      if (!proxy) {
        return {
          available: false,
          endpoint: null,
          port: null,
          host: "127.0.0.1",
          tabId,
          targetId: null,
          url: "",
          title: "",
          attached: false,
          devtoolsOpen: false,
          env: null,
          error: "CDP proxy is not running",
        };
      }

      return {
        available: true,
        endpoint: proxy.endpoint,
        port: proxy.port,
        host: "127.0.0.1",
        tabId,
        targetId: match?.targetId ?? null,
        url: match?.url ?? "",
        title: match?.title ?? "",
        attached: found?.entry.cdpProxyAttached ?? false,
        devtoolsOpen: found?.entry.devtoolsOpen ?? false,
        env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: proxy.endpoint },
      };
    },
  );
}

process.on("uncaughtExceptionMonitor", (error) => {
  desktopIncidentLogger?.error("desktop.process.uncaughtException", { error });
  console.error("[electron] uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  desktopIncidentLogger?.error("desktop.process.unhandledRejection", {
    reason:
      reason instanceof Error
        ? { name: reason.name, message: reason.message, stack: reason.stack }
        : String(reason),
  });
  console.error("[electron] unhandled rejection", reason);
});

app.on("render-process-gone", (_event, webContents, details) => {
  desktopIncidentLogger?.error("desktop.renderProcess.gone", {
    webContentsId: webContents.id,
    reason: details.reason,
    exitCode: details.exitCode,
  });
});

app.on("child-process-gone", (_event, details) => {
  desktopIncidentLogger?.error("desktop.childProcess.gone", details);
});

app.whenReady().then(async () => {
  try {
    initializeDesktopIncidentLogger();
    setApplicationIcon();
    registerOpenExternalHandler();
    registerPackagedBackendHandlers();
    registerRuntimeStatsHandler(() => packagedBackendRuntime);
    registerSystemMonitorHandler(() => packagedBackendRuntime);
    registerTerminalBrowserHandlers();
    registerCdpProxyHandlers();
    await installHooksIfNeeded({
      resourcesDir: path.join(__dirname, "..", "resources"),
    });

    const portConfig = resolveCdpProxyPort(process.env);
    const cdpProxyPort = portConfig.strict
      ? portConfig.port
      : await findAvailableCdpProxyPort(portConfig.port);
    cdpProxyRuntime = await startCdpProxy({
      host: CDP_PROXY_HOST,
      port: cdpProxyPort,
    });
    process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT = cdpProxyRuntime.endpoint;

    if (isDev) {
      // In dev mode, backend is an independent process started before Electron.
      // Notify it of the CDP proxy endpoint so PTY terminals inherit the env var.
      const backendUrl = process.env.BROWSER_VIEWER_BACKEND_URL;
      if (backendUrl) {
        try {
          const resp = await net.fetch(`${backendUrl}/internal/cdp-endpoint`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: cdpProxyRuntime.endpoint }),
          });
          if (!resp.ok) {
            console.warn(
              "[electron] failed to propagate CDP endpoint to backend",
              {
                status: resp.status,
              },
            );
          }
        } catch (error) {
          console.warn(
            "[electron] failed to propagate CDP endpoint to backend",
            {
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
    }

    if (!isDev) {
      refreshActiveRuntimeRelease();
      registerCustomProtocol(getActiveFrontendDistDir);
      await startPackagedBackendRuntime();
    }

    const openNewWindow = (): BrowserWindow => {
      return createWindow();
    };

    const openSystemMonitor = (): void => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        mainWindow = createWindow({
          hideOnClose: true,
          initialPath: "/system-monitor",
        });
        return;
      }

      mainWindow.show();
      mainWindow.focus();
      navigateWindowToPath(mainWindow, "/system-monitor");
    };

    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildApplicationMenuTemplate({
          platform: process.platform,
          onExportDesktopDiagnostics: exportDesktopDiagnostics,
          onNewWindow: openNewWindow,
          onOpenSystemMonitor: openSystemMonitor,
          onReloadLocalRuntime: reloadLocalRuntime,
        }),
      ),
    );

    mainWindow = createWindow({ hideOnClose: true });

    createTray(mainWindow, {
      onOpenSystemMonitor: openSystemMonitor,
      onReloadLocalRuntime: reloadLocalRuntime,
    });

    if (
      shouldEnableAutoUpdates({
        isPackaged: app.isPackaged,
        platform: process.platform,
      })
    ) {
      initAutoUpdater(mainWindow);
      setTimeout(() => checkForUpdates(), 3_000);
    }

    app.on("activate", () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        mainWindow = createWindow({ hideOnClose: true });
        createTray(mainWindow, {
          onOpenSystemMonitor: openSystemMonitor,
          onReloadLocalRuntime: reloadLocalRuntime,
        });
        return;
      }
      mainWindow.show();
      mainWindow.focus();
    });
  } catch (error) {
    console.error("[electron] failed to initialize application", error);
    dialog.showErrorBox("Application Failed to Start", String(error));
    app.quit();
  }
});

app.on("before-quit", (event) => {
  setIsQuitting(true);

  if (packagedBackendsStoppedForQuit) {
    return;
  }

  event.preventDefault();
  if (stoppingPackagedBackendsForQuit) {
    return;
  }

  stoppingPackagedBackendsForQuit = true;
  void (async () => {
    await Promise.allSettled([
      cdpProxyRuntime?.stop() ?? Promise.resolve(),
      packagedBackendRuntime?.stop() ?? Promise.resolve(),
    ]);
    packagedBackendsStoppedForQuit = true;
    app.quit();
  })();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
