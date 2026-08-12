import { BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import type { TerminalBrowserCreateTabRequest } from "@runweave/shared/terminal-browser-workspace";
import {
  getTerminalBrowserKey,
  terminalBrowserRuntime,
} from "./terminal-browser-runtime.js";
import { restoreTerminalBrowserTabsForWindow } from "./terminal-browser-restore.js";
import { scheduleTerminalBrowserTabsSave } from "./terminal-browser-tabs.js";
import {
  attachTerminalBrowser,
  closeTerminalBrowserEntry,
  ensureTerminalBrowserFallback,
  getExistingTerminalBrowserEntry,
  getOrCreateTerminalBrowserView,
  validateTerminalBrowserUrl,
} from "./terminal-browser-view-lifecycle.js";
import { sendTerminalBrowserTabUpdate } from "./terminal-browser-view-updates.js";
import {
  getTerminalBrowserGroup,
  getTerminalBrowserWorkspaceSnapshot,
  renameTerminalBrowserGroup,
  reorderTerminalBrowserGroupTabs,
  sendTerminalBrowserWorkspaceChanged,
} from "./terminal-browser-workspace.js";

export function registerTerminalBrowserWorkspaceHandlers(): void {
  ipcMain.handle("terminal-browser:get-workspace", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      throw new Error("Terminal browser window is unavailable");
    }
    await restoreTerminalBrowserTabsForWindow(win);
    ensureTerminalBrowserFallback(win, { emitWorkspace: false });
    return getTerminalBrowserWorkspaceSnapshot(win.id);
  });

  ipcMain.handle(
    "terminal-browser:create-tab",
    (event, request: TerminalBrowserCreateTabRequest): void => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !request || typeof request !== "object") {
        throw new Error("Invalid terminal browser tab request");
      }
      const tabId = `browser-tab-${randomUUID().slice(0, 8)}`;
      let browserGroupId: string | undefined;
      let openerTabId: string | undefined;
      if (request.placement === "current-group") {
        const group = getTerminalBrowserGroup(win.id, request.groupId);
        if (
          !group ||
          typeof request.openerTabId !== "string" ||
          !group.tabIds.includes(request.openerTabId)
        ) {
          throw new Error("Invalid current terminal browser group");
        }
        browserGroupId = group.id;
        openerTabId = request.openerTabId;
      } else if (request.placement !== "new-group") {
        throw new Error("Invalid terminal browser tab placement");
      }
      const requestedUrl = request.url;
      const safeUrl =
        requestedUrl === undefined
          ? "about:blank"
          : validateTerminalBrowserUrl(requestedUrl);
      if (!safeUrl) {
        throw new Error("Invalid terminal browser URL");
      }
      const view = getOrCreateTerminalBrowserView(win, tabId, {
        browserGroupId,
        openerTabId,
      });
      const entry = getExistingTerminalBrowserEntry(win, tabId, "create");
      attachTerminalBrowser(win, tabId, view);
      entry.lastKnownUrl = safeUrl;
      if (safeUrl !== "about:blank") {
        void view.webContents.loadURL(safeUrl).catch(() => {
          sendTerminalBrowserTabUpdate(win, tabId, entry, false);
        });
      }
    },
  );

  ipcMain.handle(
    "terminal-browser:rename-group",
    (event, groupId: unknown, name: unknown): void => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof groupId !== "string") {
        throw new Error("Invalid terminal browser group rename request");
      }
      renameTerminalBrowserGroup(win.id, groupId, name);
      sendTerminalBrowserWorkspaceChanged(win);
      scheduleTerminalBrowserTabsSave();
    },
  );

  ipcMain.handle(
    "terminal-browser:close-group",
    (event, groupId: unknown): void => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof groupId !== "string") {
        throw new Error("Invalid terminal browser group close request");
      }
      const group = getTerminalBrowserGroup(win.id, groupId);
      if (!group) {
        return;
      }
      for (const tabId of [...group.tabIds]) {
        closeTerminalBrowserEntry(win, tabId, {
          emitWorkspace: false,
          ensureFallback: false,
          persist: false,
          selectFallback: false,
        });
      }
      const fallbackTabId = ensureTerminalBrowserFallback(win, {
        emitWorkspace: false,
      });
      const fallbackEntry = terminalBrowserRuntime.entries.get(
        getTerminalBrowserKey(win, fallbackTabId),
      );
      if (
        fallbackEntry &&
        !terminalBrowserRuntime.attachedByWindowId.get(win.id)
      ) {
        attachTerminalBrowser(win, fallbackTabId, fallbackEntry.view, {
          emitWorkspace: false,
          persist: false,
        });
      }
      sendTerminalBrowserWorkspaceChanged(win);
      scheduleTerminalBrowserTabsSave();
    },
  );

  ipcMain.handle(
    "terminal-browser:reorder-group-tabs",
    (event, groupId: unknown, orderedTabIds: unknown): void => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (
        !win ||
        typeof groupId !== "string" ||
        !Array.isArray(orderedTabIds)
      ) {
        throw new Error("Invalid terminal browser group tab order");
      }
      reorderTerminalBrowserGroupTabs(win.id, groupId, orderedTabIds);
      sendTerminalBrowserWorkspaceChanged(win);
      scheduleTerminalBrowserTabsSave();
    },
  );
}
