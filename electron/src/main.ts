import "./desktop-config.js";
import { app, BrowserWindow, dialog, Menu, net } from "electron";
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

      const openSystemMonitor = (): void => {
        if (
          !desktopRuntime.mainWindow ||
          desktopRuntime.mainWindow.isDestroyed()
        ) {
          desktopRuntime.mainWindow = createWindow({
            hideOnClose: true,
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

      desktopRuntime.mainWindow = createWindow({
        hideOnClose: true,
        onReadyToShow: (win) => {
          writeBetaDesktopStatus();
          void checkAndNotifyAppServerAvailability(process.env, win);
        },
      });

      createTray(desktopRuntime.mainWindow, {
        enableUpdates: !isBetaChannel,
        onOpenSystemMonitor: openSystemMonitor,
        onReloadLocalRuntime: reloadLocalRuntime,
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
          desktopRuntime.mainWindow = createWindow({ hideOnClose: true });
          createTray(desktopRuntime.mainWindow, {
            enableUpdates: !isBetaChannel,
            onOpenSystemMonitor: openSystemMonitor,
            onReloadLocalRuntime: reloadLocalRuntime,
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
