import { Tray, Menu, BrowserWindow, app, nativeImage } from "electron";
import path from "node:path";
import { checkForUpdates } from "./updater.js";
import { setIsQuitting } from "./app-state.js";

let tray: Tray | null = null;

function resolveIcon(): Electron.NativeImage {
  const iconDir = path.join(__dirname, "../resources/icons");
  const iconFile =
    process.platform === "win32" ? "tray-icon.ico" : "tray-icon.png";
  const iconPath = path.join(iconDir, iconFile);

  try {
    const img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) {
      return nativeImage.createEmpty();
    }
    return img.resize({ width: 16, height: 16 });
  } catch {
    return nativeImage.createEmpty();
  }
}

export function createTray(mainWindow: BrowserWindow): Tray {
  const icon = resolveIcon();
  tray = new Tray(icon);
  tray.setToolTip("Browser Viewer");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "显示窗口",
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    { type: "separator" },
    {
      label: "检查更新",
      click: () => {
        checkForUpdates();
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        setIsQuitting(true);
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  return tray;
}
