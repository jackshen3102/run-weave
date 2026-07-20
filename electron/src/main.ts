import "./desktop-config.js";
import { app, BrowserWindow, dialog, ipcMain, Menu, net } from "electron";
import type {
  AttentionOpenDispatch,
  AttentionOpenIntent,
  AttentionOpenResult,
  CompanionWindowDragRequest,
} from "@runweave/shared/attention";
import path from "node:path";
import { startCdpProxy } from "./terminal-browser-cdp-proxy.js";
import {
  CDP_PROXY_HOST,
  findAvailableCdpProxyPort,
  resolveCdpProxyPort,
} from "./terminal-browser-cdp-proxy-port.js";
import { createTray } from "./tray.js";
import { checkForUpdates, initAutoUpdater } from "./updater.js";
import { setIsQuitting } from "./app-state.js";
import { shouldEnableAutoUpdates } from "./updater-config.js";
import { buildApplicationMenuTemplate } from "./application-menu.js";
import { registerTerminalBrowserHandlers } from "./terminal-browser-view.js";
import { installHooksIfNeeded } from "./hooks/hook-installer.js";
import { desktopRuntime } from "./desktop-runtime-state.js";
import {
  desktopSourceRevision,
  isBetaChannel,
  isDev,
  managesPackagedBackend,
} from "./desktop-config.js";
import {
  createWindow,
  navigateWindowToPath,
  registerCustomProtocol,
  registerOpenExternalHandler,
  registerRuntimeStatsHandler,
  registerSystemMonitorHandler,
  setApplicationIcon,
} from "./desktop-window.js";
import {
  exportDesktopDiagnostics,
  getActiveFrontendDistDir,
  initializeDesktopIncidentLogger,
  refreshActiveRuntimeRelease,
} from "./desktop-diagnostics.js";
import {
  checkAndNotifyAppServerAvailability,
  connectExternalBackendRuntime,
  registerPackagedBackendHandlers,
  reloadLocalRuntime,
  startPackagedBackendRuntime,
  writeBetaDesktopStatus,
} from "./packaged-backend-controller.js";
import { registerCdpProxyHandlers } from "./terminal-browser-cdp-handlers.js";
import {
  createCompanionWindow,
  moveCompanionWindow,
  resizeCompanionWindow,
} from "./desktop-companion-window.js";
import { readCompanionEnabled, writeCompanionEnabled } from "./desktop-companion-preferences.js";
import { writeDesktopCompanionWindowState } from "./desktop-companion-window-state.js";
import {
  readDesktopMainWindowState,
  trackDesktopMainWindowState,
} from "./desktop-main-window-state.js";

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function isAttentionIntent(value: unknown): value is AttentionOpenIntent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  const allowed = new Set(["requestId", "connectionId", "attentionId", "projectId", "terminalSessionId", "panelId", "runId", "targetSurface", "completionRevision"]);
  return keys.every((key) => allowed.has(key)) &&
    ["requestId", "connectionId", "attentionId", "projectId", "terminalSessionId"].every((key) => isId(candidate[key])) &&
    (candidate.panelId === null || isId(candidate.panelId)) &&
    (candidate.runId === null || isId(candidate.runId)) &&
    (candidate.targetSurface === "terminal" || candidate.targetSurface === "agent-team") &&
    (candidate.completionRevision === null || (Number.isInteger(candidate.completionRevision) && Number(candidate.completionRevision) >= 0));
}

function isAttentionResult(value: unknown): value is AttentionOpenResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const status = candidate.status;
  const allowedStatuses = new Set([
    "opened",
    "opened_with_panel_fallback",
    "connection_unavailable",
    "session_not_found",
    "timed_out",
  ]);
  if (!isId(candidate.requestId) || !allowedStatuses.has(String(status))) {
    return false;
  }
  const expectsMessage = status !== "opened";
  return expectsMessage
    ? typeof candidate.message === "string" && candidate.message.length <= 512
    : candidate.message === undefined;
}

function isCompanionWindowDragRequest(
  value: unknown,
): value is CompanionWindowDragRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (candidate.phase === "end") return keys.length === 1;
  return (
    (candidate.phase === "start" || candidate.phase === "move") &&
    keys.length === 3 &&
    typeof candidate.screenX === "number" &&
    Number.isFinite(candidate.screenX) &&
    typeof candidate.screenY === "number" &&
    Number.isFinite(candidate.screenY)
  );
}

function registerCompanionHandlers(): void {
  const requireCompanion = (senderId: number): BrowserWindow => {
    const win = desktopRuntime.companionWindow;
    if (!win || win.isDestroyed() || win.webContents.id !== senderId) throw new Error("Companion sender required");
    return win;
  };
  ipcMain.handle("attention:report-content-size", (event, size: unknown) => {
    const win = requireCompanion(event.sender.id);
    if (!size || typeof size !== "object") throw new Error("Invalid size");
    const { width, height } = size as { width?: unknown; height?: unknown };
    if (typeof width !== "number" || typeof height !== "number" || !Number.isFinite(width) || !Number.isFinite(height)) throw new Error("Invalid size");
    resizeCompanionWindow(win, { width, height });
  });
  ipcMain.handle("attention:set-mouse-passthrough", (event, passthrough: unknown) => {
    const win = requireCompanion(event.sender.id);
    if (typeof passthrough !== "boolean") throw new Error("Invalid passthrough state");
    win.setIgnoreMouseEvents(passthrough, passthrough ? { forward: true } : undefined);
  });
  let dragState: {
    senderId: number;
    pointerStart: { x: number; y: number };
    windowStart: { x: number; y: number };
  } | null = null;
  ipcMain.on("attention:drag-window", (event, value: unknown) => {
    const win = desktopRuntime.companionWindow;
    if (
      !win ||
      win.isDestroyed() ||
      win.webContents.id !== event.sender.id ||
      !isCompanionWindowDragRequest(value)
    ) {
      return;
    }
    if (value.phase === "start") {
      const [x = 0, y = 0] = win.getPosition();
      dragState = {
        senderId: event.sender.id,
        pointerStart: { x: value.screenX, y: value.screenY },
        windowStart: { x, y },
      };
      return;
    }
    if (!dragState || dragState.senderId !== event.sender.id) return;
    if (value.phase === "end") {
      dragState = null;
      writeDesktopCompanionWindowState(win);
      return;
    }
    moveCompanionWindow(
      win,
      {
        x: dragState.windowStart.x + value.screenX - dragState.pointerStart.x,
        y: dragState.windowStart.y + value.screenY - dragState.pointerStart.y,
      },
      { x: value.screenX, y: value.screenY },
    );
  });
  ipcMain.handle("attention:open-main-window", (event) => {
    requireCompanion(event.sender.id);
    desktopRuntime.mainWindow?.show();
    desktopRuntime.mainWindow?.focus();
  });
  const pendingRequests = new Map<string, {
    promise: Promise<AttentionOpenResult>;
    resolve: (result: AttentionOpenResult) => void;
    timer: NodeJS.Timeout;
    completionExpected: boolean;
  }>();
  const completedRequests = new Map<string, AttentionOpenResult>();
  const completePendingRequest = (result: AttentionOpenResult): boolean => {
    const pending = pendingRequests.get(result.requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingRequests.delete(result.requestId);
    completedRequests.set(result.requestId, result);
    if (completedRequests.size > 500) {
      completedRequests.delete(completedRequests.keys().next().value ?? "");
    }
    pending.resolve(result);
    return true;
  };
  ipcMain.handle("attention:open-result", (event, result: AttentionOpenResult) => {
    const mainWindow = desktopRuntime.mainWindow;
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.id !== event.sender.id) throw new Error("Main window sender required");
    if (!isAttentionResult(result)) throw new Error("Invalid result");
    const pending = pendingRequests.get(result.requestId);
    if (!pending) return;
    if (
      pending.completionExpected &&
      (result.status === "opened" || result.status === "opened_with_panel_fallback")
    ) {
      throw new Error("Completion open result must use authorization");
    }
    completePendingRequest(result);
  });
  ipcMain.handle("attention:authorize-completion", (event, result: unknown): boolean => {
    const mainWindow = desktopRuntime.mainWindow;
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.id !== event.sender.id) throw new Error("Main window sender required");
    if (!isAttentionResult(result)) throw new Error("Invalid result");
    if (result.status !== "opened" && result.status !== "opened_with_panel_fallback") throw new Error("Completion authorization requires an opened result");
    const pending = pendingRequests.get(result.requestId);
    if (!pending || !pending.completionExpected) return false;
    return completePendingRequest(result);
  });
  ipcMain.handle("attention:open-slot", async (event, value: unknown): Promise<AttentionOpenResult> => {
    requireCompanion(event.sender.id);
    if (!isAttentionIntent(value)) throw new Error("Invalid attention intent");
    const completed = completedRequests.get(value.requestId);
    if (completed) return completed;
    const existing = pendingRequests.get(value.requestId);
    if (existing) return existing.promise;
    const mainWindow = desktopRuntime.mainWindow;
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { requestId: value.requestId, status: "session_not_found", message: "Main window unavailable" };
    }
    let resolveResult!: (result: AttentionOpenResult) => void;
    const promise = new Promise<AttentionOpenResult>((resolve) => { resolveResult = resolve; });
    const deadlineAt = Date.now() + 10_000;
    const timer = setTimeout(() => {
      pendingRequests.delete(value.requestId);
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("attention:open-cancel", value.requestId);
      }
      const result: AttentionOpenResult = { requestId: value.requestId, status: "timed_out", message: "Main window did not finish opening the Slot" };
      completedRequests.set(value.requestId, result);
      resolveResult(result);
    }, 10_000);
    pendingRequests.set(value.requestId, {
      promise,
      resolve: resolveResult,
      timer,
      completionExpected: value.completionRevision !== null,
    });
    mainWindow.show();
    mainWindow.focus();
    const dispatch: AttentionOpenDispatch = { ...value, deadlineAt };
    mainWindow.webContents.send("attention:open-intent", dispatch);
    return promise;
  });
}

process.on("uncaughtExceptionMonitor", (error) => {
  desktopRuntime.incidentLogger?.error("desktop.process.uncaughtException", {
    error,
  });
  console.error("[electron] uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  desktopRuntime.incidentLogger?.error("desktop.process.unhandledRejection", {
    reason:
      reason instanceof Error
        ? { name: reason.name, message: reason.message, stack: reason.stack }
        : String(reason),
  });
  console.error("[electron] unhandled rejection", reason);
});

app.on("render-process-gone", (_event, webContents, details) => {
  desktopRuntime.incidentLogger?.error("desktop.renderProcess.gone", {
    webContentsId: webContents.id,
    reason: details.reason,
    exitCode: details.exitCode,
  });
});

app.on("child-process-gone", (_event, details) => {
  desktopRuntime.incidentLogger?.error("desktop.childProcess.gone", details);
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!desktopRuntime.mainWindow || desktopRuntime.mainWindow.isDestroyed()) {
      return;
    }
    if (desktopRuntime.mainWindow.isMinimized()) {
      desktopRuntime.mainWindow.restore();
    }
    desktopRuntime.mainWindow.show();
    desktopRuntime.mainWindow.focus();
  });
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    try {
      initializeDesktopIncidentLogger();
      writeBetaDesktopStatus();
      setApplicationIcon();
      registerOpenExternalHandler();
      registerPackagedBackendHandlers();
      registerRuntimeStatsHandler(() => desktopRuntime.packagedBackend);
      registerSystemMonitorHandler(() => desktopRuntime.packagedBackend);
      registerTerminalBrowserHandlers();
      registerCdpProxyHandlers();
      registerCompanionHandlers();
      if (!isBetaChannel) {
        await installHooksIfNeeded({
          resourcesDir: process.env.RUNWEAVE_ELECTRON_RESOURCES_DIR
            ? path.resolve(process.env.RUNWEAVE_ELECTRON_RESOURCES_DIR)
            : path.join(__dirname, "..", "resources"),
        });
      }

      const portConfig = resolveCdpProxyPort(process.env);
      const cdpProxyPort = portConfig.strict
        ? portConfig.port
        : await findAvailableCdpProxyPort(portConfig.port);
      desktopRuntime.cdpProxy = await startCdpProxy({
        host: CDP_PROXY_HOST,
        port: cdpProxyPort,
        identity: {
          instanceId:
            process.env.RUNWEAVE_DESKTOP_INSTANCE_ID?.trim() || null,
          devSessionId: process.env.RUNWEAVE_DEV_SESSION_ID?.trim() || null,
          sourceRevision: desktopSourceRevision,
          pid: process.pid,
        },
      });
      process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT =
        desktopRuntime.cdpProxy.endpoint;
      writeBetaDesktopStatus();

      if (isDev || !managesPackagedBackend) {
        // In dev mode, backend is an independent process started before Electron.
        // Notify it of the CDP proxy endpoint so PTY terminals inherit the env var.
        const backendUrl =
          process.env.RUNWEAVE_BACKEND_URL ??
          process.env.BROWSER_VIEWER_BACKEND_URL;
        if (backendUrl) {
          try {
            const resp = await net.fetch(
              `${backendUrl}/internal/cdp-endpoint`,
              {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  endpoint: desktopRuntime.cdpProxy.endpoint,
                }),
              },
            );
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
        if (managesPackagedBackend) {
          await startPackagedBackendRuntime();
        } else {
          await connectExternalBackendRuntime();
        }
      }

      const openNewWindow = (): BrowserWindow => {
        return createWindow();
      };

      const createMainWindow = (options?: {
        initialPath?: string;
        onReadyToShow?: (win: BrowserWindow) => void;
      }): BrowserWindow => {
        const restoredState = isBetaChannel
          ? null
          : readDesktopMainWindowState();
        const win = createWindow({
          hideOnClose: true,
          initialBounds: restoredState?.bounds,
          initialMode: restoredState?.mode,
          initialPath: options?.initialPath,
          onReadyToShow: options?.onReadyToShow,
        });
        if (!isBetaChannel) {
          trackDesktopMainWindowState(win, restoredState?.mode ?? "normal");
        }
        return win;
      };

      const openSystemMonitor = (): void => {
        if (
          !desktopRuntime.mainWindow ||
          desktopRuntime.mainWindow.isDestroyed()
        ) {
          desktopRuntime.mainWindow = createMainWindow({
            initialPath: "/system-monitor",
          });
          return;
        }

        desktopRuntime.mainWindow.show();
        desktopRuntime.mainWindow.focus();
        navigateWindowToPath(desktopRuntime.mainWindow, "/system-monitor");
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

      desktopRuntime.mainWindow = createMainWindow({
        onReadyToShow: (win) => {
          writeBetaDesktopStatus();
          void checkAndNotifyAppServerAvailability(process.env, win);
        },
      });

      let companionEnabled = await readCompanionEnabled();
      const setCompanionEnabled = (enabled: boolean): void => {
        companionEnabled = enabled;
        void writeCompanionEnabled(enabled);
        if (enabled) {
          if (!desktopRuntime.companionWindow || desktopRuntime.companionWindow.isDestroyed()) {
            desktopRuntime.companionWindow = createCompanionWindow();
            desktopRuntime.companionWindow.once("closed", () => {
              desktopRuntime.companionWindow = null;
            });
          }
        } else {
          desktopRuntime.companionWindow?.destroy();
          desktopRuntime.companionWindow = null;
        }
      };
      if (companionEnabled) setCompanionEnabled(true);

      createTray(desktopRuntime.mainWindow, {
        enableUpdates: !isBetaChannel,
        onOpenSystemMonitor: openSystemMonitor,
        onReloadLocalRuntime: reloadLocalRuntime,
        companionEnabled,
        onSetCompanionEnabled: setCompanionEnabled,
      });

      if (
        !isBetaChannel &&
        shouldEnableAutoUpdates({
          isPackaged: app.isPackaged,
          platform: process.platform,
        })
      ) {
        initAutoUpdater(desktopRuntime.mainWindow);
        setTimeout(() => checkForUpdates(), 3_000);
      }

      app.on("activate", () => {
        if (
          !desktopRuntime.mainWindow ||
          desktopRuntime.mainWindow.isDestroyed()
        ) {
          desktopRuntime.mainWindow = createMainWindow();
          createTray(desktopRuntime.mainWindow, {
            enableUpdates: !isBetaChannel,
            onOpenSystemMonitor: openSystemMonitor,
            onReloadLocalRuntime: reloadLocalRuntime,
            companionEnabled,
            onSetCompanionEnabled: setCompanionEnabled,
          });
          return;
        }
        desktopRuntime.mainWindow.show();
        desktopRuntime.mainWindow.focus();
      });
    } catch (error) {
      console.error("[electron] failed to initialize application", error);
      dialog.showErrorBox("Application Failed to Start", String(error));
      app.quit();
    }
  });
}

app.on("before-quit", (event) => {
  setIsQuitting(true);
  writeBetaDesktopStatus(new Date().toISOString());

  if (desktopRuntime.packagedBackendsStoppedForQuit) {
    return;
  }

  event.preventDefault();
  if (desktopRuntime.stoppingPackagedBackendsForQuit) {
    return;
  }

  desktopRuntime.stoppingPackagedBackendsForQuit = true;
  void (async () => {
    await Promise.allSettled([
      desktopRuntime.cdpProxy?.stop() ?? Promise.resolve(),
      desktopRuntime.packagedBackend?.stop() ?? Promise.resolve(),
    ]);
    desktopRuntime.packagedBackendsStoppedForQuit = true;
    app.quit();
  })();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
