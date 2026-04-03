import {
  app,
  BrowserWindow,
  dialog,
  protocol,
  net,
} from "electron";
import path from "node:path";
import { resolveProtocolFilePath } from "./protocol-path.js";
import { startPackagedBackend, type PackagedBackendRuntime } from "./backend-runtime.js";
import { createTray } from "./tray.js";
import { initAutoUpdater, checkForUpdates } from "./updater.js";
import { getIsQuitting, setIsQuitting } from "./app-state.js";

const isDev = !app.isPackaged;

const DEV_SERVER_URL =
  process.env.BROWSER_VIEWER_DEV_URL ?? "http://localhost:5173";

const RENDERER_DIST = path.join(__dirname, "../../frontend/dist");
const PRELOAD_PATH = path.join(__dirname, "preload.cjs");

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

function createWindow(): BrowserWindow {
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
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadURL(`${CUSTOM_PROTOCOL}://app/index.html`);
  }

  setupSessionIntercept(win);

  return win;
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
      headers["Access-Control-Allow-Headers"] = ["Content-Type, Authorization"];
    }

    callback({ responseHeaders: headers });
  });
}

app.commandLine.appendSwitch("ignore-certificate-errors");

let packagedBackendRuntime: PackagedBackendRuntime | null = null;

app.whenReady().then(async () => {
  try {
    if (!isDev) {
      registerCustomProtocol();
      packagedBackendRuntime = await startPackagedBackend({
        baseEnv: process.env,
      });
      process.env.BROWSER_VIEWER_BACKEND_URL = packagedBackendRuntime.backendUrl;
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

    const mainWindow = createWindow();

    createTray(mainWindow);

    if (!isDev) {
      initAutoUpdater(mainWindow);
      setTimeout(() => checkForUpdates(), 3_000);
    }

    mainWindow.on("close", (event) => {
      if (!getIsQuitting()) {
        event.preventDefault();
        mainWindow.hide();
      }
    });

    app.on("activate", () => {
      mainWindow.show();
      mainWindow.focus();
    });
  } catch (error) {
    console.error("[electron] failed to initialize application", error);
    dialog.showErrorBox(
      "Application Failed to Start",
      String(error),
    );
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
