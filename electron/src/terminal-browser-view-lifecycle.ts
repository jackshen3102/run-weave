import { BrowserWindow, shell, WebContentsView } from "electron";
import { randomUUID } from "node:crypto";
import { createTerminalBrowserDeviceState } from "@runweave/shared/terminal-browser-device";
import {
  normalizeTerminalBrowserUrlForStorage,
  selectTerminalBrowserTabsForRestore,
} from "./terminal-browser-tabs-state.js";
import { readTerminalBrowserPersistedState } from "./terminal-browser-tabs-persistence.js";
import {
  clearTerminalBrowserAnnotation,
  clearTerminalBrowserAnnotationsForWindow,
} from "./terminal-browser-annotation.js";
import { getIsQuitting } from "./app-state.js";
import {
  detachTerminalBrowserDeviceDebugger,
} from "./terminal-browser-device-emulation.js";
import {
  TERMINAL_BROWSER_SESSION_PARTITION,
  createTerminalBrowserGroupId,
  getTerminalBrowserKey,
  terminalBrowserEvents,
  terminalBrowserRuntime,
  type TerminalBrowserBounds,
  type TerminalBrowserEntry,
} from "./terminal-browser-runtime.js";
import {
  insertTerminalBrowserTabOrder,
  reconcileTerminalBrowserTabOrder,
  removeTerminalBrowserTabOrder,
  scheduleTerminalBrowserTabsSave,
} from "./terminal-browser-tabs.js";
import {
  clearPendingTerminalBrowserTabUpdate,
  clearTerminalBrowserAnnotationAndNotify,
  sendTerminalBrowserTabUpdate,
} from "./terminal-browser-view-updates.js";

export function isTerminalBrowserBounds(
  value: unknown,
): value is TerminalBrowserBounds {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const hasBounds = ["x", "y", "width", "height"].every(
    (key) =>
      typeof candidate[key] === "number" && Number.isFinite(candidate[key]),
  );
  if (!hasBounds) {
    return false;
  }
  return (
    candidate.emulationScale === undefined ||
    (typeof candidate.emulationScale === "number" &&
      Number.isFinite(candidate.emulationScale) &&
      candidate.emulationScale > 0)
  );
}

export function validateTerminalBrowserUrl(url: string): string | null {
  return normalizeTerminalBrowserUrlForStorage(url);
}

export function openTerminalBrowserExternalUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) {
      return;
    }
    void shell.openExternal(url);
  } catch {
    return;
  }
}

export function createTerminalBrowserPopupWindowOptions(
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

export async function restoreTerminalBrowserTabsForWindow(
  win: BrowserWindow,
): Promise<void> {
  if (terminalBrowserRuntime.persistedStateRestored) {
    return;
  }
  terminalBrowserRuntime.persistedStateRestored = true;

  if (reconcileTerminalBrowserTabOrder(win.id).length > 0) {
    return;
  }

  const state = await readTerminalBrowserPersistedState();
  if (state.tabs.length === 0) {
    return;
  }

  terminalBrowserRuntime.restoringWindows.add(win.id);
  try {
    const restoredTabs = selectTerminalBrowserTabsForRestore(
      state.tabs,
      state.activeTabId,
    );
    for (const tab of restoredTabs) {
      const view = getOrCreateTerminalBrowserView(win, tab.id, {
        browserGroupId: tab.browserGroupId,
      });
      const entry = terminalBrowserRuntime.entries.get(
        getTerminalBrowserKey(win, tab.id),
      );
      if (!entry) {
        continue;
      }
      entry.lastActiveAt = tab.lastActiveAt;
      entry.lastKnownUrl = tab.url;
      void view.webContents.loadURL(tab.url).catch(() => {
        sendTerminalBrowserTabUpdate(win, tab.id, entry, false);
      });
    }

    const activeTabId =
      state.activeTabId &&
      restoredTabs.some((tab) => tab.id === state.activeTabId)
        ? state.activeTabId
        : (restoredTabs[0]?.id ?? null);
    if (activeTabId) {
      const activeEntry = terminalBrowserRuntime.entries.get(
        getTerminalBrowserKey(win, activeTabId),
      );
      if (activeEntry) {
        attachTerminalBrowser(win, activeTabId, activeEntry.view);
      }
    }
  } finally {
    terminalBrowserRuntime.restoringWindows.delete(win.id);
  }
}

export function getExistingTerminalBrowserEntry(
  win: BrowserWindow,
  tabId: string,
  action: string,
): TerminalBrowserEntry {
  const entry = terminalBrowserRuntime.entries.get(
    getTerminalBrowserKey(win, tabId),
  );
  if (!entry) {
    throw new Error(`Cannot ${action} closed browser tab`);
  }
  return entry;
}

export function getOrCreateTerminalBrowserView(
  win: BrowserWindow,
  tabId: string,
  options: { browserGroupId?: string; openerTabId?: string } = {},
): WebContentsView {
  const key = getTerminalBrowserKey(win, tabId);
  const existing = terminalBrowserRuntime.entries.get(key);
  if (existing) {
    return existing.view;
  }

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: TERMINAL_BROWSER_SESSION_PARTITION,
      sandbox: true,
    },
  });
  view.webContents.setWindowOpenHandler(({ url, disposition }) => {
    const safeUrl = validateTerminalBrowserUrl(url);
    if (!safeUrl) {
      openTerminalBrowserExternalUrl(url);
      return { action: "deny" };
    }
    // `window.open(url, name, "width=...,height=...")` reports `new-window`;
    // keep those as real popup windows so OAuth / auth flows that rely on
    // `window.opener` and `postMessage` callbacks keep working. Plain
    // `target="_blank"` / tab-style opens report `foreground-tab` /
    // `background-tab` — surface those as a new tab in the right-side panel
    // instead of spawning a separate window.
    //
    // This holds even when the CDP proxy is attached: the page-opened tab
    // inherits the opener's `browserGroupId`, so it stays within the same
    // proxy control group and a connected client still discovers it via
    // `Target.targetCreated`. A human clicking a link must always be able to
    // open it, regardless of whether an agent is driving this tab.
    if (disposition === "new-window") {
      return {
        action: "allow",
        overrideBrowserWindowOptions:
          createTerminalBrowserPopupWindowOptions(win),
      };
    }
    createTerminalBrowserTabFromPageOpen(
      win,
      safeUrl,
      entry.browserGroupId,
      tabId,
    );
    return { action: "deny" };
  });
  view.webContents.on("did-create-window", (popupWindow) => {
    configureTerminalBrowserPopupWindow(win, popupWindow);
  });
  view.setVisible(false);

  const entry: TerminalBrowserEntry = {
    windowId: win.id,
    view,
    attached: false,
    targetId: randomUUID(),
    browserGroupId: options.browserGroupId ?? createTerminalBrowserGroupId(),
    cdpProxyAttached: false,
    mcpActivityUntil: null,
    devtoolsOpen: false,
    deviceState: createTerminalBrowserDeviceState("desktop"),
    emulationScale: 1,
    defaultUserAgent: view.webContents.getUserAgent(),
    deviceDebuggerAttached: false,
    onDeviceDebuggerDetach: null,
    lastActiveAt: Date.now(),
    lastKnownUrl: "about:blank",
    lastSentUpdateKey: null,
    lastSentUpdateAt: 0,
    pendingUpdate: null,
    pendingUpdateTimer: null,
  };

  view.webContents.on("devtools-opened", () => {
    entry.devtoolsOpen = true;
    sendTerminalBrowserTabUpdate(win, tabId, entry);
  });
  view.webContents.on("devtools-closed", () => {
    entry.devtoolsOpen = false;
    sendTerminalBrowserTabUpdate(win, tabId, entry);
  });
  view.webContents.on("did-start-loading", () => {
    sendTerminalBrowserTabUpdate(win, tabId, entry, true);
  });
  view.webContents.on("did-stop-loading", () => {
    sendTerminalBrowserTabUpdate(win, tabId, entry, false);
  });
  view.webContents.on("did-navigate", () => {
    clearTerminalBrowserAnnotationAndNotify(win, tabId);
    sendTerminalBrowserTabUpdate(win, tabId, entry);
  });
  view.webContents.on("did-navigate-in-page", () => {
    clearTerminalBrowserAnnotationAndNotify(win, tabId);
    sendTerminalBrowserTabUpdate(win, tabId, entry);
  });
  view.webContents.on("page-title-updated", () => {
    sendTerminalBrowserTabUpdate(win, tabId, entry);
  });

  terminalBrowserRuntime.entries.set(key, entry);
  insertTerminalBrowserTabOrder(win.id, tabId, options.openerTabId);
  void view.webContents.loadURL("about:blank").catch(() => undefined);
  return view;
}

export function createTerminalBrowserTabFromPageOpen(
  win: BrowserWindow,
  url: string,
  browserGroupId: string,
  openerTabId?: string,
): void {
  const tabId = `browser-tab-${randomUUID().slice(0, 8)}`;
  const view = getOrCreateTerminalBrowserView(win, tabId, {
    browserGroupId,
    openerTabId,
  });
  const entry = terminalBrowserRuntime.entries.get(
    getTerminalBrowserKey(win, tabId),
  );
  if (!entry) {
    return;
  }

  attachTerminalBrowser(win, tabId, view);
  entry.lastKnownUrl = url;
  // Notify the renderer so the frontend tab bar picks up the new tab. Include
  // the opener tab id so the panel can insert it to the right of the tab that
  // spawned it, matching browser tab behavior.
  win.webContents.send("terminal-browser:tab-created-from-proxy", {
    tabId,
    browserGroupId: entry.browserGroupId,
    url,
    title: "",
    openerTabId,
  });
  void view.webContents.loadURL(url).catch(() => {
    sendTerminalBrowserTabUpdate(win, tabId, entry, false);
  });
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
    const safeUrl = validateTerminalBrowserUrl(url);
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

export function detachTerminalBrowser(
  win: BrowserWindow,
  tabId?: string,
): void {
  const attachedTabId = terminalBrowserRuntime.attachedByWindowId.get(win.id);
  if (!attachedTabId || (tabId && attachedTabId !== tabId)) {
    return;
  }
  const entry = terminalBrowserRuntime.entries.get(
    getTerminalBrowserKey(win, attachedTabId),
  );
  entry?.view.setVisible(false);
}

export function attachTerminalBrowser(
  win: BrowserWindow,
  tabId: string,
  view: WebContentsView,
): void {
  const attachedTabId = terminalBrowserRuntime.attachedByWindowId.get(win.id);
  if (attachedTabId === tabId) {
    view.setVisible(true);
    return;
  }
  for (const entry of terminalBrowserRuntime.entries.values()) {
    if (entry.windowId === win.id) {
      entry.view.setVisible(false);
    }
  }
  const entry = terminalBrowserRuntime.entries.get(
    getTerminalBrowserKey(win, tabId),
  );
  if (entry && !entry.attached) {
    win.contentView.addChildView(view);
    entry.attached = true;
  }
  view.setVisible(true);
  terminalBrowserRuntime.attachedByWindowId.set(win.id, tabId);
  if (entry) {
    entry.lastActiveAt = Date.now();
  }
  if (!terminalBrowserRuntime.restoringWindows.has(win.id)) {
    scheduleTerminalBrowserTabsSave();
  }
}

export function closeTerminalBrowserEntry(
  win: BrowserWindow,
  tabId: string,
  options: { persist?: boolean } = {},
): void {
  const wasActive =
    terminalBrowserRuntime.attachedByWindowId.get(win.id) === tabId;
  detachTerminalBrowser(win, tabId);
  if (wasActive) {
    terminalBrowserRuntime.attachedByWindowId.delete(win.id);
  }
  const key = getTerminalBrowserKey(win, tabId);
  const entry = terminalBrowserRuntime.entries.get(key);
  if (!entry) {
    return;
  }
  if (entry.attached) {
    win.contentView.removeChildView(entry.view);
  }
  clearPendingTerminalBrowserTabUpdate(entry);
  detachTerminalBrowserDeviceDebugger(entry);
  terminalBrowserRuntime.entries.delete(key);
  removeTerminalBrowserTabOrder(win.id, tabId);
  clearTerminalBrowserAnnotation(key);
  terminalBrowserEvents.emit("tab-closed", {
    targetId: entry.targetId,
    browserGroupId: entry.browserGroupId,
  });
  if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send("terminal-browser:tab-closed", { tabId });
  }
  entry.view.webContents.close();
  if (options.persist !== false) {
    scheduleTerminalBrowserTabsSave();
  }
}

export function closeTerminalBrowsersForWindow(windowId: number): void {
  terminalBrowserRuntime.attachedByWindowId.delete(windowId);
  terminalBrowserRuntime.tabOrderByWindowId.delete(windowId);
  clearTerminalBrowserAnnotationsForWindow(windowId);
  for (const [key, entry] of terminalBrowserRuntime.entries) {
    if (entry.windowId !== windowId) {
      continue;
    }
    terminalBrowserRuntime.entries.delete(key);
    clearTerminalBrowserAnnotation(key);
    terminalBrowserEvents.emit("tab-closed", {
      targetId: entry.targetId,
      browserGroupId: entry.browserGroupId,
    });
    clearPendingTerminalBrowserTabUpdate(entry);
    detachTerminalBrowserDeviceDebugger(entry);
    entry.view.webContents.close();
  }
  terminalBrowserEvents.emit("window-closed", { windowId });
  if (!getIsQuitting()) {
    scheduleTerminalBrowserTabsSave();
  }
}

export function clampTerminalBrowserBounds(
  win: BrowserWindow,
  bounds: TerminalBrowserBounds,
): TerminalBrowserBounds {
  const content = win.getContentBounds();
  const maxWidth = Math.max(0, content.width - bounds.x);
  const maxHeight = Math.max(0, content.height - bounds.y);
  return {
    x: Math.max(0, Math.min(Math.round(bounds.x), content.width)),
    y: Math.max(0, Math.min(Math.round(bounds.y), content.height)),
    width: Math.max(0, Math.min(Math.round(bounds.width), maxWidth)),
    height: Math.max(0, Math.min(Math.round(bounds.height), maxHeight)),
  };
}
