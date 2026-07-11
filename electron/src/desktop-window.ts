import {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  net,
  protocol,
  shell,
} from "electron";
import pidusage from "pidusage";
import type { RuntimeStatsSnapshot } from "@runweave/shared/runtime-monitor";
import type { SystemMonitorSnapshot } from "@runweave/shared/system-monitor";
import type { PackagedBackendRuntime } from "./backend-runtime.js";
import { resolveProtocolFilePath } from "./protocol-path.js";
import { getIsQuitting } from "./app-state.js";
import {
  buildRuntimeStatsSnapshot,
  type ElectronProcessMetric,
} from "./runtime-monitor.js";
import { buildSystemMonitorSnapshot } from "./system-monitor.js";
import { shouldAutoOpenWindowDevtools } from "./window-devtools.js";
import { closeTerminalBrowsersForWindow } from "./terminal-browser-view.js";
import {
  CUSTOM_PROTOCOL,
  DEV_DOCK_ICON_PATH,
  DEV_SERVER_URL,
  LEGACY_CUSTOM_PROTOCOL,
  PRELOAD_PATH,
  isBetaChannel,
  isDev,
} from "./desktop-config.js";

export function registerCustomProtocol(getFrontendDistDir: () => string) {
  const handleAppProtocol = (request: Request) => {
    const resolved = resolveProtocolFilePath(request.url, getFrontendDistDir());

    if (resolved.status === "forbidden") {
      return new Response("Forbidden", { status: 403 });
    }

    return net.fetch(`file://${resolved.filePath}`);
  };

  protocol.handle(CUSTOM_PROTOCOL, handleAppProtocol);
  protocol.handle(LEGACY_CUSTOM_PROTOCOL, handleAppProtocol);
}

export function registerOpenExternalHandler(): void {
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

export function registerRuntimeStatsHandler(
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

export function registerSystemMonitorHandler(
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

export function isSystemMonitorSenderAllowed(senderUrl: string): boolean {
  try {
    const parsed = new URL(senderUrl);
    if (isDev) {
      const devUrl = new URL(DEV_SERVER_URL);
      if (parsed.origin !== devUrl.origin) {
        return false;
      }
    } else if (
      parsed.protocol !== `${CUSTOM_PROTOCOL}:` &&
      parsed.protocol !== `${LEGACY_CUSTOM_PROTOCOL}:`
    ) {
      return false;
    }

    return parsed.pathname === "/system-monitor";
  } catch {
    return false;
  }
}

export function createWindow(options?: {
  hideOnClose?: boolean;
  initialPath?: string;
  onReadyToShow?: (win: BrowserWindow) => void;
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
    title: isBetaChannel ? "Runweave Beta" : "Runweave",
  });

  win.once("ready-to-show", () => {
    win.show();
    options?.onReadyToShow?.(win);
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

export function navigateWindowToPath(
  win: BrowserWindow,
  routePath: string,
): void {
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

export function setApplicationIcon(): void {
  if (process.platform !== "darwin") {
    return;
  }

  const icon = nativeImage.createFromPath(DEV_DOCK_ICON_PATH);
  if (icon.isEmpty()) {
    return;
  }

  app.dock.setIcon(icon);
}

export function isBackendRequest(url: string): boolean {
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

export function hasResponseHeader(
  headers: Record<string, string[]>,
  headerName: string,
): boolean {
  const normalizedHeaderName = headerName.toLowerCase();
  return Object.keys(headers).some(
    (name) => name.toLowerCase() === normalizedHeaderName,
  );
}

export function setupSessionIntercept(win: BrowserWindow) {
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const headers: Record<string, string[]> = { ...details.responseHeaders };

    delete headers["content-security-policy"];
    delete headers["Content-Security-Policy"];

    if (
      isBackendRequest(details.url) &&
      !hasResponseHeader(headers, "Access-Control-Allow-Origin")
    ) {
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
