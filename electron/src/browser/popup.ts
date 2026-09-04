import { BrowserWindow, shell } from "electron";
import { normalizeTerminalBrowserUrlForStorage } from "./tabs/state.js";
import {
  getTerminalBrowserProfileConfig,
  type TerminalBrowserProfileId,
} from "@runweave/shared/terminal-browser-profile";

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
  profileId: TerminalBrowserProfileId,
): Electron.BrowserWindowConstructorOptions {
  return {
    parent: parentWindow,
    show: false,
    title: "Runweave Browser",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: getTerminalBrowserProfileConfig(profileId).partition,
      sandbox: true,
    },
  };
}

export function configureTerminalBrowserPopupWindow(
  parentWindow: BrowserWindow,
  popupWindow: BrowserWindow,
  profileId: TerminalBrowserProfileId,
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
      overrideBrowserWindowOptions: createTerminalBrowserPopupWindowOptions(
        parentWindow,
        profileId,
      ),
    };
  });
  popupWindow.webContents.on("did-create-window", (childWindow) => {
    configureTerminalBrowserPopupWindow(parentWindow, childWindow, profileId);
  });
}

export { createTerminalBrowserPopupWindowOptions };
