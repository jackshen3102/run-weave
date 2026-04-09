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
import type { RuntimeStatsSnapshot } from "@browser-viewer/shared";
import { resolveProtocolFilePath } from "./protocol-path.js";
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
import { buildApplicationMenuTemplate } from "./application-menu.js";
import { shouldAutoOpenWindowDevtools } from "./window-devtools.js";

const isDev = !app.isPackaged;

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
let mainWindow: BrowserWindow | null = null;

app.whenReady().then(async () => {
  try {
    setApplicationIcon();
    registerOpenExternalHandler();
    registerRuntimeStatsHandler(() => packagedBackendRuntime);
    if (!isDev) {
      registerCustomProtocol();
      packagedBackendRuntime = await startPackagedBackend({
        baseEnv: process.env,
      });
      process.env.BROWSER_VIEWER_BACKEND_URL =
        packagedBackendRuntime.backendUrl;
      packagedBackendRuntime.child.once("exit", (code, signal) => {
        if (!getIsQuitting()) {
          dialog.showErrorBox(
            "Backend Stopped",
            `The packaged backend exited unexpectedly (code=${code}, signal=${signal ?? "none"}).`,
          );
          app.quit();
        }
      });
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
  void packagedBackendRuntime?.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
