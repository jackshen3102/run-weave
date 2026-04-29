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
import pidusage from "pidusage";
import path from "node:path";
import type {
  PackagedBackendConnectionState,
  RuntimeStatsSnapshot,
  TerminalBrowserCdpProxyInfo,
} from "@browser-viewer/shared";
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
  type PackagedBackendRuntime,
} from "./backend-runtime.js";
import { createTray } from "./tray.js";
import { initAutoUpdater, checkForUpdates } from "./updater.js";
import { getIsQuitting, setIsQuitting } from "./app-state.js";
import { shouldEnableAutoUpdates } from "./updater-config.js";
import {
  buildRuntimeStatsSnapshot,
  type ElectronProcessMetric,
} from "./runtime-monitor.js";
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

const RENDERER_DIST = path.join(__dirname, "../../frontend/dist");
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

function registerCustomProtocol() {
  protocol.handle(CUSTOM_PROTOCOL, (request) => {
    const resolved = resolveProtocolFilePath(request.url, RENDERER_DIST);

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

function createWindow(options?: { hideOnClose?: boolean }): BrowserWindow {
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
    win.loadURL(DEV_SERVER_URL);
    if (shouldAutoOpenWindowDevtools({ isDev })) {
      win.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    win.loadURL(`${CUSTOM_PROTOCOL}://app/index.html`);
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
      p.startsWith("/devtools/") ||
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
let packagedBackendState: PackagedBackendConnectionState = {
  kind: "packaged-local",
  available: false,
  backendUrl: process.env.BROWSER_VIEWER_BACKEND_URL ?? "",
  statusMessage: null,
  canReconnect: true,
};
let packagedBackendRestartPromise:
  | Promise<PackagedBackendConnectionState>
  | null = null;
const expectedPackagedBackendExits = new WeakSet<object>();

function broadcastPackagedBackendState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("viewer:packaged-backend-state", packagedBackendState);
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

function attachPackagedBackendExitHandler(runtime: PackagedBackendRuntime): void {
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
    const runtime = await startPackagedBackend({
      baseEnv: process.env,
    });

    packagedBackendRuntime = runtime;
    attachPackagedBackendExitHandler(runtime);
    return setPackagedBackendState(
      createAvailablePackagedBackendState(runtime.backendUrl),
    );
  } catch (error) {
    console.error("[electron] packaged backend unavailable", error);
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

app.whenReady().then(async () => {
  try {
    setApplicationIcon();
    registerOpenExternalHandler();
    registerPackagedBackendHandlers();
    registerRuntimeStatsHandler(() => packagedBackendRuntime);
    registerTerminalBrowserHandlers();
    registerCdpProxyHandlers();
    await installHooksIfNeeded();

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
            console.warn("[electron] failed to propagate CDP endpoint to backend", {
              status: resp.status,
            });
          }
        } catch (error) {
          console.warn("[electron] failed to propagate CDP endpoint to backend", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (!isDev) {
      registerCustomProtocol();
      await startPackagedBackendRuntime();
    }

    const openNewWindow = (): BrowserWindow => {
      return createWindow();
    };

    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildApplicationMenuTemplate({
          platform: process.platform,
          onNewWindow: openNewWindow,
        }),
      ),
    );

    mainWindow = createWindow({ hideOnClose: true });

    createTray(mainWindow);

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
        createTray(mainWindow);
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

app.on("before-quit", () => {
  setIsQuitting(true);
  void cdpProxyRuntime?.stop();
  void packagedBackendRuntime?.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
