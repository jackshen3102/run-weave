import { BrowserWindow, shell } from "electron";
import { normalizeTerminalBrowserUrlForStorage } from "./terminal-browser-tabs-state.js";
import { TERMINAL_BROWSER_SESSION_PARTITION } from "./terminal-browser-runtime.js";

export function openTerminalBrowserExternalUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (["http:", "https:", "mailto:"].includes(parsed.protocol)) {
      void shell.openExternal(url);
    }
  } catch {
    return;
  }
}

function createTerminalBrowserPopupWindowOptions(
  parentWindow: BrowserWindow,
): Electron.BrowserWindowConstructorOptions {
  return {
    parent: parentWindow,
    show: false,
    title: "Runweave Browser",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: TERMINAL_BROWSER_SESSION_PARTITION,
      sandbox: true,
    },
  };
}

export function configureTerminalBrowserPopupWindow(
  parentWindow: BrowserWindow,
  popupWindow: BrowserWindow,
): void {
  popupWindow.once("ready-to-show", () => {
    if (!popupWindow.isDestroyed()) {
      popupWindow.show();
    }
  });
  popupWindow.webContents.setWindowOpenHandler(({ url }) => {
    const safeUrl = normalizeTerminalBrowserUrlForStorage(url);
    if (!safeUrl) {
      openTerminalBrowserExternalUrl(url);
      return { action: "deny" };
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions:
        createTerminalBrowserPopupWindowOptions(parentWindow),
    };
  });
  popupWindow.webContents.on("did-create-window", (childWindow) => {
    configureTerminalBrowserPopupWindow(parentWindow, childWindow);
  });
}

export { createTerminalBrowserPopupWindowOptions };
