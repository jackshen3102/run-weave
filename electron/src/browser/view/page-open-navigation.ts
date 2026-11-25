import type { BrowserWindow } from "electron";
import { terminalBrowserEvents, type TerminalBrowserEntry } from "../runtime.js";
import { sendTerminalBrowserTabUpdate } from "./updates.js";

export function navigatePageOpenedTab(
  win: BrowserWindow,
  tabId: string,
  entry: TerminalBrowserEntry,
  url: string,
): void {
  entry.lastKnownUrl = url;
  const contents = entry.view.webContents;
  let published = false;
  const publishTarget = (): void => {
    if (published || contents.isDestroyed()) return;
    published = true;
    contents.removeListener("did-navigate", publishTarget);
    terminalBrowserEvents.emit("tab-available", {
      targetId: entry.targetId,
      profileId: entry.profileId,
      browserGroupId: entry.browserGroupId,
      url: contents.getURL() || entry.lastKnownUrl,
      title: contents.getTitle(),
      openerId: entry.openerId,
      canAccessOpener: false,
    });
  };
  // Attach after the initial navigation commits, when CDP can initialize its
  // main frame. A failed load still leaves an available tab.
  contents.once("did-navigate", publishTarget);
  void contents.loadURL(url).then(publishTarget, () => {
    publishTarget();
    sendTerminalBrowserTabUpdate(win, tabId, entry, false);
  });
}
