import { BrowserWindow, ipcMain } from "electron";
import type { TerminalBrowserMinimumViewportWidthState } from "@runweave/shared/terminal-browser-minimum-width";
import { setTerminalBrowserMinimumViewportWidth } from "./terminal-browser-display-scale.js";
import { getExistingTerminalBrowserEntry } from "./terminal-browser-view-lifecycle.js";
import { sendTerminalBrowserTabUpdate } from "./terminal-browser-view-updates.js";
import { relayoutTerminalBrowserViewport } from "./terminal-browser-viewport-layout.js";

export function registerTerminalBrowserMinimumWidthHandler(): void {
  ipcMain.handle(
    "terminal-browser:set-minimum-viewport-width",
    async (
      event,
      tabId: string,
      width: unknown,
    ): Promise<TerminalBrowserMinimumViewportWidthState> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser minimum viewport width request");
      }
      const entry = getExistingTerminalBrowserEntry(
        win,
        tabId,
        "update minimum viewport width for",
      );
      const state = await setTerminalBrowserMinimumViewportWidth(entry, width);
      relayoutTerminalBrowserViewport(entry, 0);
      sendTerminalBrowserTabUpdate(win, tabId, entry);
      return state;
    },
  );
}
