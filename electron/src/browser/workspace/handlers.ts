import { BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import type { TerminalBrowserCreateTabRequest } from "@runweave/shared/terminal-browser-workspace";
import { isTerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
import {
  getTerminalBrowserKey,
  getTerminalBrowserWorkspaceKey,
  terminalBrowserRuntime,
} from "../runtime.js";
import { restoreTerminalBrowserTabsForWindow } from "../restore.js";
import { scheduleTerminalBrowserTabsSave } from "../tabs/index.js";
import {
  attachTerminalBrowser,
  closeTerminalBrowserEntry,
  ensureTerminalBrowserFallback,
  getExistingTerminalBrowserEntry,
  getOrCreateTerminalBrowserView,
  validateTerminalBrowserUrl,
} from "../view/lifecycle.js";
import { sendTerminalBrowserTabUpdate } from "../view/updates.js";
import {
  getTerminalBrowserGroup,
  getTerminalBrowserWorkspaceSnapshot,
  ensureTerminalBrowserDormantFallback,
  renameTerminalBrowserGroup,
  reorderTerminalBrowserGroupTabs,
  sendTerminalBrowserWorkspaceChanged,
} from "./index.js";

export function registerTerminalBrowserWorkspaceHandlers(): void {
  ipcMain.handle("terminal-browser:get-workspace", async (event, profileId) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !isTerminalBrowserProfileId(profileId)) {
      throw new Error("Terminal browser window is unavailable");
    }
    await restoreTerminalBrowserTabsForWindow(win);
    ensureTerminalBrowserDormantFallback(win.id, profileId);
    return getTerminalBrowserWorkspaceSnapshot(win.id, profileId);
  });

  ipcMain.handle(
    "terminal-browser:create-tab",
    (event, request: TerminalBrowserCreateTabRequest): void => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (
        !win ||
        !request ||
        typeof request !== "object" ||
        !isTerminalBrowserProfileId(request.profileId)
      ) {
        throw new Error("Invalid terminal browser tab request");
      }
      const tabId = `browser-tab-${randomUUID().slice(0, 8)}`;
      let browserGroupId: string | undefined;
      let openerTabId: string | undefined;
      if (request.placement === "current-group") {
        const group = getTerminalBrowserGroup(
          win.id,
          request.profileId,
          request.groupId,
        );
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
      const view = getOrCreateTerminalBrowserView(
        win,
        request.profileId,
        tabId,
        {
          browserGroupId,
          openerTabId,
        },
      );
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
    (event, profileId: unknown, groupId: unknown, name: unknown): void => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (
        !win ||
        !isTerminalBrowserProfileId(profileId) ||
        typeof groupId !== "string"
      ) {
        throw new Error("Invalid terminal browser group rename request");
      }
      renameTerminalBrowserGroup(win.id, profileId, groupId, name);
      sendTerminalBrowserWorkspaceChanged(win, profileId);
      scheduleTerminalBrowserTabsSave();
    },
  );

  ipcMain.handle(
    "terminal-browser:close-group",
    (event, profileId: unknown, groupId: unknown): void => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (
        !win ||
        !isTerminalBrowserProfileId(profileId) ||
        typeof groupId !== "string"
      ) {
        throw new Error("Invalid terminal browser group close request");
      }
      const group = getTerminalBrowserGroup(win.id, profileId, groupId);
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
      const fallbackTabId = ensureTerminalBrowserFallback(win, profileId, {
        emitWorkspace: false,
      });
      const fallbackEntry = fallbackTabId
        ? terminalBrowserRuntime.entries.get(
            getTerminalBrowserKey(win, profileId, fallbackTabId),
          )
        : null;
      if (
        fallbackEntry &&
        !terminalBrowserRuntime.attachedByWorkspaceKey.get(
          getTerminalBrowserWorkspaceKey(win.id, profileId),
        )
      ) {
        attachTerminalBrowser(win, fallbackTabId!, fallbackEntry.view, {
          emitWorkspace: false,
          persist: false,
        });
      }
      sendTerminalBrowserWorkspaceChanged(win, profileId);
      scheduleTerminalBrowserTabsSave();
    },
  );

  ipcMain.handle(
    "terminal-browser:reorder-group-tabs",
    (
      event,
      profileId: unknown,
      groupId: unknown,
      orderedTabIds: unknown,
    ): void => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (
        !win ||
        !isTerminalBrowserProfileId(profileId) ||
        typeof groupId !== "string" ||
        !Array.isArray(orderedTabIds)
      ) {
        throw new Error("Invalid terminal browser group tab order");
      }
      reorderTerminalBrowserGroupTabs(
        win.id,
        profileId,
        groupId,
        orderedTabIds,
      );
      sendTerminalBrowserWorkspaceChanged(win, profileId);
      scheduleTerminalBrowserTabsSave();
    },
  );
}
