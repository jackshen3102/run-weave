import { sleepIdleTerminalBrowserTabs } from "../view/sleep.js";
import { resolveTerminalBrowserProfile } from "../profile/runtime.js";
import { BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import type { TerminalBrowserCreateTabRequest } from "@runweave/shared/terminal-browser-workspace";
import {
  TERMINAL_BROWSER_PROFILE_IDS,
  isTerminalBrowserProfileId,
} from "@runweave/shared/terminal-browser-profile";
import {
  getTerminalBrowserKey,
  findTerminalBrowserEntryForWindow,
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
  getOrderedTerminalBrowserTabIds,
  getTerminalBrowserWorkspaceSnapshot,
  ensureTerminalBrowserDormantFallback,
  renameTerminalBrowserGroup,
  reorderTerminalBrowserGroupTabs,
  sendTerminalBrowserWorkspaceChanged,
} from "./index.js";

export function registerTerminalBrowserWorkspaceHandlers(): void {
  ipcMain.handle("terminal-browser:show", async (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof tabId !== "string") {
      return;
    }
    const request = {};
    terminalBrowserRuntime.showRequestByWindowId.set(win.id, request);
    const previous = findTerminalBrowserEntryForWindow(win, tabId)?.entry;
    if (previous?.sleepPromise) await previous.sleepPromise;
    if (
      win.isDestroyed() ||
      terminalBrowserRuntime.showRequestByWindowId.get(win.id) !== request
    )
      return;
    const profileId = TERMINAL_BROWSER_PROFILE_IDS.find((profile) =>
      getOrderedTerminalBrowserTabIds(win.id, profile).includes(tabId),
    );
    if (!profileId) return;
    const view = getOrCreateTerminalBrowserView(win, profileId, tabId);
    const entry = terminalBrowserRuntime.entries.get(
      getTerminalBrowserKey(win, profileId, tabId),
    );
    if (!entry) return;
    attachTerminalBrowser(win, tabId, view);
    sendTerminalBrowserTabUpdate(win, tabId, entry);
  });

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
    "terminal-browser:sleep-idle-tabs",
    async (event, profileId: unknown) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (
        !win ||
        event.senderFrame !== event.sender.mainFrame ||
        !isTerminalBrowserProfileId(profileId)
      ) {
        throw new Error("Invalid terminal browser sleep request");
      }
      return await sleepIdleTerminalBrowserTabs(win, profileId);
    },
  );

  ipcMain.handle(
    "terminal-browser:create-tab",
    async (event, request: TerminalBrowserCreateTabRequest): Promise<void> => {
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
      await resolveTerminalBrowserProfile(
        {
          projectId: null,
          explicitProfileId: request.profileId,
          browserGroupId: browserGroupId ?? null,
        },
        { excludedWindowId: win.id },
      );
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
      if (
        !terminalBrowserRuntime.attachedByWorkspaceKey.get(
          getTerminalBrowserWorkspaceKey(win.id, profileId),
        )
      ) {
        attachTerminalBrowser(
          win,
          fallbackTabId,
          getOrCreateTerminalBrowserView(win, profileId, fallbackTabId),
          {
            emitWorkspace: false,
            persist: false,
          },
        );
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
