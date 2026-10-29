import { BrowserWindow, shell } from "electron";
import { normalizeTerminalBrowserUrlForStorage } from "./tabs/state.js";
import { attachBrowserPlugins } from "./plugins/host.js";
import { randomUUID } from "node:crypto";
import { terminalBrowserRuntime, terminalBrowserEvents } from "./runtime.js";
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
  groupId: () => string,
  openerId: string,
  openerContents: Electron.WebContents,
): void {
  const targetId = `browser-popup-${randomUUID()}`;
  const popup = {
    window: popupWindow, ownerWindowId: parentWindow.id, profileId,
    browserGroupId: groupId(), targetId, openerId, activeDownloads: 0,
  };
  terminalBrowserRuntime.popups.set(targetId, popup);
  const closeWithOpener = () => {
    if (!popupWindow.isDestroyed()) popupWindow.destroy();
  };
  openerContents.once("destroyed", closeWithOpener);
  popupWindow.once("closed", () => {
    openerContents.removeListener("destroyed", closeWithOpener);
    terminalBrowserRuntime.popups.delete(targetId);
    terminalBrowserEvents.emit("tab-closed", popup);
  });
  attachBrowserPlugins({
    contents: popupWindow.webContents,
    profileId,
    pageId: targetId,
    groupId: () => popup.browserGroupId,
    kind: "popup",
    restoring: false,
    displayUrl: (url) => url,
  });
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
    configureTerminalBrowserPopupWindow(
      parentWindow,
      childWindow,
      profileId,
      () => popup.browserGroupId,
      targetId,
      popupWindow.webContents,
    );
  });
  terminalBrowserEvents.emit("tab-awakened", {
    targetId, profileId, browserGroupId: popup.browserGroupId, openerId,
    url: popupWindow.webContents.getURL() || "about:blank", title: popupWindow.webContents.getTitle(),
  });
}

export { createTerminalBrowserPopupWindowOptions };
