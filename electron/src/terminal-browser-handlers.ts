import { BrowserWindow, ipcMain } from "electron";
import {
  createTerminalBrowserDeviceState,
  normalizeTerminalBrowserDevicePresetId,
  type TerminalBrowserDeviceState,
} from "@runweave/shared/terminal-browser-device";
import type { TerminalBrowserHeaderState } from "@runweave/shared/terminal-browser-headers";
import type { TerminalBrowserProxyState } from "@runweave/shared/terminal-browser-proxy";
import {
  deleteTerminalBrowserAnnotation,
  listTerminalBrowserAnnotations,
  startTerminalBrowserAnnotation,
  stopTerminalBrowserAnnotation,
  submitTerminalBrowserAnnotations,
} from "./terminal-browser-annotation.js";
import {
  applyTerminalBrowserDeviceEmulation,
  clampTerminalBrowserEmulationScale,
  getTerminalBrowserDeviceState,
  isTerminalBrowserMobileDeviceState,
  updateTerminalBrowserEmulationScale,
} from "./terminal-browser-device-emulation.js";
import { ensureTerminalBrowserCookiePersistence } from "./terminal-browser-cookie-persistence.js";
import {
  getTerminalBrowserKey,
  getTerminalBrowserSession,
  terminalBrowserRuntime,
  type TerminalBrowserSnapshot,
} from "./terminal-browser-runtime.js";
import {
  getTerminalBrowserHeaderState,
  getTerminalBrowserProxyState,
  ensureTerminalBrowserHeaderDispatcher,
  setTerminalBrowserHeaderRules,
  setTerminalBrowserProxyEnabled,
} from "./terminal-browser-network.js";
import {
  getLiveTerminalBrowserTabIds,
  scheduleTerminalBrowserTabsSave,
} from "./terminal-browser-tabs.js";
import {
  attachTerminalBrowser,
  clampTerminalBrowserBounds,
  closeTerminalBrowserEntry,
  detachTerminalBrowser,
  getExistingTerminalBrowserEntry,
  getOrCreateTerminalBrowserView,
  isTerminalBrowserBounds,
  restoreTerminalBrowserTabsForWindow,
  validateTerminalBrowserUrl,
} from "./terminal-browser-view-lifecycle.js";
import {
  getTerminalBrowserSnapshot,
  isNavigationAbortError,
  sendTerminalBrowserTabUpdate,
} from "./terminal-browser-view-updates.js";
import { getTerminalBrowserTabsForWindow } from "./terminal-browser-proxy-api.js";

export function registerTerminalBrowserHandlers(): void {
  ensureTerminalBrowserHeaderDispatcher();
  ensureTerminalBrowserCookiePersistence(getTerminalBrowserSession());

  ipcMain.handle("terminal-browser:get-proxy-state", () => {
    return getTerminalBrowserProxyState();
  });

  ipcMain.handle(
    "terminal-browser:set-proxy-enabled",
    async (_event, enabled: unknown): Promise<TerminalBrowserProxyState> => {
      if (typeof enabled !== "boolean") {
        throw new Error("Invalid browser proxy state");
      }
      return await setTerminalBrowserProxyEnabled(enabled);
    },
  );

  ipcMain.handle("terminal-browser:get-header-rules", () => {
    return getTerminalBrowserHeaderState();
  });

  ipcMain.handle(
    "terminal-browser:set-header-rules",
    (_event, rules: unknown): TerminalBrowserHeaderState => {
      return setTerminalBrowserHeaderRules(rules);
    },
  );

  ipcMain.handle("terminal-browser:list-tabs", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return [];
    }
    await restoreTerminalBrowserTabsForWindow(win);
    return getTerminalBrowserTabsForWindow(win.id);
  });

  ipcMain.handle(
    "terminal-browser:reorder-tabs",
    (event, orderedTabIds: unknown): void => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !Array.isArray(orderedTabIds)) {
        throw new Error("Invalid terminal browser tab order");
      }
      const liveTabIds = getLiveTerminalBrowserTabIds(win.id);
      const candidateTabIds = orderedTabIds.filter(
        (tabId): tabId is string => typeof tabId === "string",
      );
      const candidateTabIdSet = new Set(candidateTabIds);
      const liveTabIdSet = new Set(liveTabIds);
      const valid =
        candidateTabIds.length === orderedTabIds.length &&
        candidateTabIds.length === liveTabIds.length &&
        candidateTabIdSet.size === candidateTabIds.length &&
        candidateTabIds.every((tabId) => liveTabIdSet.has(tabId));
      if (!valid) {
        throw new Error("Invalid terminal browser tab order");
      }
      terminalBrowserRuntime.tabOrderByWindowId.set(win.id, [
        ...candidateTabIds,
      ]);
      scheduleTerminalBrowserTabsSave();
    },
  );

  ipcMain.handle("terminal-browser:show", (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof tabId !== "string") {
      return;
    }
    const view = getOrCreateTerminalBrowserView(win, tabId);
    attachTerminalBrowser(win, tabId, view);
    const entry = terminalBrowserRuntime.entries.get(
      getTerminalBrowserKey(win, tabId),
    );
    if (entry) {
      sendTerminalBrowserTabUpdate(win, tabId, entry);
    }
  });

  ipcMain.handle("terminal-browser:hide", (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof tabId !== "string") {
      return;
    }
    detachTerminalBrowser(win, tabId);
  });

  ipcMain.handle(
    "terminal-browser:get-device-state",
    (event, tabId: string): TerminalBrowserDeviceState => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser device state request");
      }
      const entry = terminalBrowserRuntime.entries.get(
        getTerminalBrowserKey(win, tabId),
      );
      if (!entry || entry.view.webContents.isDestroyed()) {
        return createTerminalBrowserDeviceState("desktop");
      }
      return getTerminalBrowserDeviceState(entry);
    },
  );

  ipcMain.handle(
    "terminal-browser:set-device-state",
    async (
      event,
      tabId: string,
      presetId: unknown,
    ): Promise<TerminalBrowserDeviceState> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser device state request");
      }
      const entry = getExistingTerminalBrowserEntry(
        win,
        tabId,
        "update device",
      );
      const normalizedPresetId =
        normalizeTerminalBrowserDevicePresetId(presetId);
      const nextState = await applyTerminalBrowserDeviceEmulation(
        entry,
        normalizedPresetId,
      );
      sendTerminalBrowserTabUpdate(win, tabId, entry);
      return nextState;
    },
  );

  ipcMain.handle(
    "terminal-browser:navigate",
    async (
      event,
      tabId: string,
      url: string,
    ): Promise<TerminalBrowserSnapshot> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const safeUrl = validateTerminalBrowserUrl(url);
      if (!win || !safeUrl || typeof tabId !== "string") {
        throw new Error("Invalid browser navigation request");
      }

      const view = getOrCreateTerminalBrowserView(win, tabId);
      const entry = terminalBrowserRuntime.entries.get(
        getTerminalBrowserKey(win, tabId),
      );
      if (entry) {
        entry.lastKnownUrl = safeUrl;
      }
      try {
        await view.webContents.loadURL(safeUrl);
      } catch (error) {
        if (!isNavigationAbortError(error)) {
          throw error;
        }
      }
      return getTerminalBrowserSnapshot(view, entry?.lastKnownUrl ?? safeUrl);
    },
  );

  ipcMain.handle(
    "terminal-browser:reload",
    async (event, tabId: string): Promise<TerminalBrowserSnapshot> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser reload request");
      }
      const entry = getExistingTerminalBrowserEntry(win, tabId, "reload");
      const { view } = entry;
      view.webContents.reload();
      return getTerminalBrowserSnapshot(view, entry.lastKnownUrl);
    },
  );

  ipcMain.handle("terminal-browser:stop", (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof tabId !== "string") {
      return;
    }
    const entry = terminalBrowserRuntime.entries.get(
      getTerminalBrowserKey(win, tabId),
    );
    entry?.view.webContents.stop();
  });

  ipcMain.handle(
    "terminal-browser:go-back",
    async (event, tabId: string): Promise<TerminalBrowserSnapshot> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser history request");
      }
      const entry = getExistingTerminalBrowserEntry(win, tabId, "go back");
      const { view } = entry;
      if (view.webContents.navigationHistory.canGoBack()) {
        view.webContents.navigationHistory.goBack();
      }
      return getTerminalBrowserSnapshot(view, entry.lastKnownUrl);
    },
  );

  ipcMain.handle(
    "terminal-browser:go-forward",
    async (event, tabId: string): Promise<TerminalBrowserSnapshot> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser history request");
      }
      const entry = getExistingTerminalBrowserEntry(win, tabId, "go forward");
      const { view } = entry;
      if (view.webContents.navigationHistory.canGoForward()) {
        view.webContents.navigationHistory.goForward();
      }
      return getTerminalBrowserSnapshot(view, entry.lastKnownUrl);
    },
  );

  ipcMain.handle(
    "terminal-browser:set-bounds",
    async (event, tabId: string, bounds: unknown) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        return;
      }
      if (bounds === null) {
        detachTerminalBrowser(win, tabId);
        return;
      }
      if (!isTerminalBrowserBounds(bounds)) {
        return;
      }
      const entry = terminalBrowserRuntime.entries.get(
        getTerminalBrowserKey(win, tabId),
      );
      if (!entry) {
        return;
      }
      const nextBounds = clampTerminalBrowserBounds(win, bounds);
      entry.view.setBounds(nextBounds);
      await updateTerminalBrowserEmulationScale(
        entry,
        clampTerminalBrowserEmulationScale(bounds.emulationScale),
      );
    },
  );

  ipcMain.handle("terminal-browser:open-devtools", (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof tabId !== "string") {
      return;
    }
    const entry = terminalBrowserRuntime.entries.get(
      getTerminalBrowserKey(win, tabId),
    );
    if (!entry) {
      return;
    }
    if (entry.cdpProxyAttached) {
      throw new Error(
        "Cannot open DevTools while CDP proxy is attached to this tab",
      );
    }
    if (isTerminalBrowserMobileDeviceState(entry)) {
      throw new Error("Cannot open DevTools while mobile mode is active");
    }
    entry.view.webContents.openDevTools({ mode: "detach" });
  });

  ipcMain.handle("terminal-browser:close-tab", (event, tabId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof tabId !== "string") {
      return;
    }
    closeTerminalBrowserEntry(win, tabId);
  });

  ipcMain.handle(
    "terminal-browser:annotation-start",
    async (event, tabId: string) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser annotation request");
      }
      const entry = getExistingTerminalBrowserEntry(win, tabId, "annotate");
      const state = await startTerminalBrowserAnnotation(
        getTerminalBrowserKey(win, tabId),
        entry.view.webContents,
      );
      win.webContents.send("terminal-browser:annotation-updated", {
        tabId,
        state,
      });
      return state;
    },
  );

  ipcMain.handle(
    "terminal-browser:annotation-stop",
    async (event, tabId: string) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        return { active: false, annotations: [] };
      }
      const state = await stopTerminalBrowserAnnotation(
        getTerminalBrowserKey(win, tabId),
      );
      win.webContents.send("terminal-browser:annotation-updated", {
        tabId,
        state,
      });
      return state;
    },
  );

  ipcMain.handle(
    "terminal-browser:annotation-list",
    async (event, tabId: string) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        return { active: false, annotations: [] };
      }
      return await listTerminalBrowserAnnotations(
        getTerminalBrowserKey(win, tabId),
      );
    },
  );

  ipcMain.handle(
    "terminal-browser:annotation-delete",
    async (event, tabId: string, annotationId: string) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (
        !win ||
        typeof tabId !== "string" ||
        typeof annotationId !== "string"
      ) {
        throw new Error("Invalid browser annotation delete request");
      }
      const state = await deleteTerminalBrowserAnnotation(
        getTerminalBrowserKey(win, tabId),
        annotationId,
      );
      win.webContents.send("terminal-browser:annotation-updated", {
        tabId,
        state,
      });
      return state;
    },
  );

  ipcMain.handle(
    "terminal-browser:annotation-submit",
    async (event, tabId: string) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || typeof tabId !== "string") {
        throw new Error("Invalid browser annotation submit request");
      }
      const submission = await submitTerminalBrowserAnnotations(
        getTerminalBrowserKey(win, tabId),
      );
      win.webContents.send("terminal-browser:annotation-updated", {
        tabId,
        state: { active: false, annotations: [] },
      });
      return submission;
    },
  );
}
