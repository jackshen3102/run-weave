import pkg from "electron-updater";
const { autoUpdater } = pkg;
type UpdateInfo = pkg.UpdateInfo;
import { BrowserWindow, dialog } from "electron";
import { getCustomUpdateBaseUrl } from "./updater-config.js";

let mainWindow: BrowserWindow | null = null;

export function initAutoUpdater(win: BrowserWindow): void {
  mainWindow = win;
  const updateBaseUrl = getCustomUpdateBaseUrl(
    process.env.BROWSER_VIEWER_LOCAL_UPDATES_URL,
  );

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  if (updateBaseUrl) {
    autoUpdater.setFeedURL({
      provider: "generic",
      url: updateBaseUrl,
    });
  }

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    if (!mainWindow) return;

    dialog
      .showMessageBox(mainWindow, {
        type: "info",
        title: "发现新版本",
        message: `发现新版本 v${info.version}，是否立即下载？`,
        buttons: ["下载", "稍后"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.downloadUpdate();
        }
      });
  });

  autoUpdater.on("update-not-available", () => {
    /* silent */
  });

  autoUpdater.on("update-downloaded", () => {
    if (!mainWindow) return;

    dialog
      .showMessageBox(mainWindow, {
        type: "info",
        title: "更新已就绪",
        message: "新版本已下载完成，重启应用以完成更新。",
        buttons: ["立即重启", "稍后"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on("error", (error: Error) => {
    console.error("[auto-updater]", error.message);
  });
}

export function checkForUpdates(): void {
  autoUpdater.checkForUpdates().catch((error: unknown) => {
    console.error("[auto-updater] check failed:", error);
  });
}
