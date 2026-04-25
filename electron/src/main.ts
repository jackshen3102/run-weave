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
  WebContentsView,
} from "electron";
import pidusage from "pidusage";
import path from "node:path";
import type {
  PackagedBackendConnectionState,
  RuntimeStatsSnapshot,
} from "@browser-viewer/shared";
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
import {
  createAvailablePackagedBackendState,
  createUnavailablePackagedBackendStateFromError,
  createUnavailablePackagedBackendStateFromExit,
} from "./packaged-backend-state.js";
import { buildApplicationMenuTemplate } from "./application-menu.js";
import { shouldAutoOpenWindowDevtools } from "./window-devtools.js";

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

interface TerminalBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TerminalBrowserSnapshot {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface TerminalBrowserEntry {
  windowId: number;
  view: WebContentsView;
  attached: boolean;
}

const terminalBrowserEntries = new Map<string, TerminalBrowserEntry>();
const attachedTerminalBrowserByWindowId = new Map<number, string>();

function isTerminalBrowserBounds(value: unknown): value is TerminalBrowserBounds {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every(
    (key) => typeof candidate[key] === "number" && Number.isFinite(candidate[key]),
  );
}

function validateTerminalBrowserUrl(url: string): string | null {
  if (typeof url !== "string") {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function getTerminalBrowserKey(win: BrowserWindow, tabId: string): string {
  return `${win.id}:${tabId}`;
}

function getTerminalBrowserSnapshot(view: WebContentsView): TerminalBrowserSnapshot {
  return {
    url: view.webContents.getURL(),
    title: view.webContents.getTitle(),
    canGoBack: view.webContents.canGoBack(),
    canGoForward: view.webContents.canGoForward(),
  };
}

function getExistingTerminalBrowserEntry(
  win: BrowserWindow,
  tabId: string,
  action: string,
): TerminalBrowserEntry {
  const entry = terminalBrowserEntries.get(getTerminalBrowserKey(win, tabId));
  if (!entry) {
    throw new Error(`Cannot ${action} closed browser tab`);
  }
  return entry;
}

function getOrCreateTerminalBrowserView(
  win: BrowserWindow,
  tabId: string,
): WebContentsView {
  const key = getTerminalBrowserKey(win, tabId);
  const existing = terminalBrowserEntries.get(key);
  if (existing) {
    return existing.view;
  }

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  view.webContents.setWindowOpenHandler(({ url }) => {
    const safeUrl = validateTerminalBrowserUrl(url);
    if (safeUrl) {
      void shell.openExternal(safeUrl);
    }
    return { action: "deny" };
  });
  view.setVisible(false);
  terminalBrowserEntries.set(key, { windowId: win.id, view, attached: false });
  return view;
}

function detachTerminalBrowser(win: BrowserWindow, tabId?: string): void {
  const attachedTabId = attachedTerminalBrowserByWindowId.get(win.id);
  if (!attachedTabId || (tabId && attachedTabId !== tabId)) {
    return;
  }
  const entry = terminalBrowserEntries.get(getTerminalBrowserKey(win, attachedTabId));
  entry?.view.setVisible(false);
  attachedTerminalBrowserByWindowId.delete(win.id);
}

function attachTerminalBrowser(
  win: BrowserWindow,
  tabId: string,
  view: WebContentsView,
): void {
  const attachedTabId = attachedTerminalBrowserByWindowId.get(win.id);
  if (attachedTabId === tabId) {
    view.setVisible(true);
    return;
  }
  for (const entry of terminalBrowserEntries.values()) {
    if (entry.windowId === win.id) {
      entry.view.setVisible(false);
    }
  }
  const entry = terminalBrowserEntries.get(getTerminalBrowserKey(win, tabId));
  if (entry && !entry.attached) {
    win.contentView.addChildView(view);
    entry.attached = true;
  }
  view.setVisible(true);
  attachedTerminalBrowserByWindowId.set(win.id, tabId);
}

function closeTerminalBrowserEntry(win: BrowserWindow, tabId: string): void {
  detachTerminalBrowser(win, tabId);
  const key = getTerminalBrowserKey(win, tabId);
  const entry = terminalBrowserEntries.get(key);
  if (!entry) {
    return;
  }
  if (entry.attached) {
    win.contentView.removeChildView(entry.view);
  }
  terminalBrowserEntries.delete(key);
  entry.view.webContents.close();
}

function closeTerminalBrowsersForWindow(windowId: number): void {
  attachedTerminalBrowserByWindowId.delete(windowId);
  for (const [key, entry] of terminalBrowserEntries) {
    if (entry.windowId !== windowId) {
      continue;
    }
    terminalBrowserEntries.delete(key);
    entry.view.webContents.close();
  }
}

function clampTerminalBrowserBounds(
  win: BrowserWindow,
  bounds: TerminalBrowserBounds,
): TerminalBrowserBounds {
  const content = win.getContentBounds();
  const maxWidth = Math.max(0, content.width - bounds.x);
  const maxHeight = Math.max(0, content.height - bounds.y);
  return {
    x: Math.max(0, Math.min(Math.round(bounds.x), content.width)),
    y: Math.max(0, Math.min(Math.round(bounds.y), content.height)),
    width: Math.max(0, Math.min(Math.round(bounds.width), maxWidth)),
    height: Math.max(0, Math.min(Math.round(bounds.height), maxHeight)),
  };
}

function registerTerminalBrowserHandlers(): void {
  ipcMain.handle("terminal-browser:show", (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof tabId !== "string") {
      return;
    }
    const view = getOrCreateTerminalBrowserView(win, tabId);
    attachTerminalBrowser(win, tabId, view);
  });

  ipcMain.handle("terminal-browser:hide", (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof tabId !== "string") {
      return;
    }
    detachTerminalBrowser(win, tabId);
  });

  ipcMain.handle(
    "terminal-browser:navigate",
    async (event, tabId: string, url: string): Promise<TerminalBrowserSnapshot> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const safeUrl = validateTerminalBrowserUrl(url);
      if (!win || !safeUrl || typeof tabId !== "string") {
        throw new Error("Invalid browser navigation request");
      }

      const view = getOrCreateTerminalBrowserView(win, tabId);
      await view.webContents.loadURL(safeUrl);
      return getTerminalBrowserSnapshot(view);
    },
  );

  ipcMain.handle(
    "terminal-browser:reload",
    async (event, tabId: string): Promise<TerminalBrowserSnapshot> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser reload request");
      }
      const { view } = getExistingTerminalBrowserEntry(win, tabId, "reload");
      view.webContents.reload();
      return getTerminalBrowserSnapshot(view);
    },
  );

  ipcMain.handle("terminal-browser:stop", (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof tabId !== "string") {
      return;
    }
    const entry = terminalBrowserEntries.get(getTerminalBrowserKey(win, tabId));
    entry?.view.webContents.stop();
  });

  ipcMain.handle(
    "terminal-browser:go-back",
    async (event, tabId: string): Promise<TerminalBrowserSnapshot> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser history request");
      }
      const { view } = getExistingTerminalBrowserEntry(win, tabId, "go back");
      if (view.webContents.canGoBack()) {
        view.webContents.goBack();
      }
      return getTerminalBrowserSnapshot(view);
    },
  );

  ipcMain.handle(
    "terminal-browser:go-forward",
    async (event, tabId: string): Promise<TerminalBrowserSnapshot> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser history request");
      }
      const { view } = getExistingTerminalBrowserEntry(win, tabId, "go forward");
      if (view.webContents.canGoForward()) {
        view.webContents.goForward();
      }
      return getTerminalBrowserSnapshot(view);
    },
  );

  ipcMain.handle(
    "terminal-browser:set-bounds",
    (event, tabId: string, bounds: unknown) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        return;
      }
      if (bounds === null) {
        detachTerminalBrowser(win, tabId);
        return;
      }
      if (!isTerminalBrowserBounds(bounds)) {
        return;
      }
      const entry = terminalBrowserEntries.get(getTerminalBrowserKey(win, tabId));
      if (!entry) {
        return;
      }
      const nextBounds = clampTerminalBrowserBounds(win, bounds);
      entry.view.setBounds(nextBounds);
    },
  );

  ipcMain.handle("terminal-browser:open-devtools", (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof tabId !== "string") {
      return;
    }
    const entry = terminalBrowserEntries.get(getTerminalBrowserKey(win, tabId));
    entry?.view.webContents.openDevTools({ mode: "detach" });
  });

  ipcMain.handle("terminal-browser:close-tab", (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof tabId !== "string") {
      return;
    }
    closeTerminalBrowserEntry(win, tabId);
  });
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

app.whenReady().then(async () => {
  try {
    setApplicationIcon();
    registerOpenExternalHandler();
    registerPackagedBackendHandlers();
    registerRuntimeStatsHandler(() => packagedBackendRuntime);
    registerTerminalBrowserHandlers();
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
  void packagedBackendRuntime?.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
