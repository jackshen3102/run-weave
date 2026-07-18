import { type BrowserWindow, type WebContentsView } from "electron";
import type { TerminalBrowserDeviceState } from "@runweave/shared/terminal-browser-device";
import { clearTerminalBrowserAnnotation } from "./terminal-browser-annotation.js";
import { getTerminalBrowserDeviceState } from "./terminal-browser-device-emulation.js";
import {
  getTerminalBrowserKey,
  type TerminalBrowserEntry,
  type TerminalBrowserSnapshot,
  type TerminalBrowserUpdate,
} from "./terminal-browser-runtime.js";
import { scheduleTerminalBrowserTabsSave } from "./terminal-browser-tabs.js";

const TERMINAL_BROWSER_TAB_UPDATE_THROTTLE_MS = 50;

export function getTerminalBrowserSnapshot(
  view: WebContentsView,
  fallbackUrl = "",
): TerminalBrowserSnapshot {
  const history = view.webContents.navigationHistory;
  return {
    url: view.webContents.getURL() || fallbackUrl,
    title: view.webContents.getTitle(),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
  };
}

export function isNavigationAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const message = String((error as { message?: unknown }).message ?? "");
  return message.includes("ERR_ABORTED") || message.includes("(-3)");
}

export function getTerminalBrowserDeviceStateUpdateKey(
  deviceState: TerminalBrowserDeviceState,
): string {
  const viewport = deviceState.viewport;
  return [
    deviceState.presetId,
    deviceState.label,
    deviceState.mobile ? "1" : "0",
    viewport?.width ?? "",
    viewport?.height ?? "",
    viewport?.deviceScaleFactor ?? "",
  ].join(":");
}

export function getTerminalBrowserUpdateKey(
  update: TerminalBrowserUpdate,
): string {
  return [
    update.tabId,
    update.browserGroupId,
    update.url,
    update.title,
    update.canGoBack ? "1" : "0",
    update.canGoForward ? "1" : "0",
    update.loading ? "1" : "0",
    update.cdpProxyAttached ? "1" : "0",
    update.mcpActivityUntil ?? "",
    update.devtoolsOpen ? "1" : "0",
    getTerminalBrowserDeviceStateUpdateKey(update.deviceState),
    update.displayScale,
  ].join("\u001f");
}

export function clearPendingTerminalBrowserTabUpdate(
  entry: TerminalBrowserEntry,
): void {
  if (entry.pendingUpdateTimer) {
    clearTimeout(entry.pendingUpdateTimer);
    entry.pendingUpdateTimer = null;
  }
  entry.pendingUpdate = null;
}

export function commitTerminalBrowserTabUpdate(
  win: BrowserWindow,
  entry: TerminalBrowserEntry,
  update: TerminalBrowserUpdate,
  updateKey: string,
): void {
  if (entry.lastSentUpdateKey === updateKey) {
    clearPendingTerminalBrowserTabUpdate(entry);
    return;
  }
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    return;
  }
  if (entry.view.webContents.isDestroyed()) {
    return;
  }
  entry.lastSentUpdateKey = updateKey;
  entry.lastSentUpdateAt = Date.now();
  win.webContents.send("terminal-browser:tab-updated", update);
  scheduleTerminalBrowserTabsSave();
}

export function queueTerminalBrowserTabUpdate(
  win: BrowserWindow,
  entry: TerminalBrowserEntry,
  update: TerminalBrowserUpdate,
  updateKey: string,
): void {
  if (entry.lastSentUpdateKey === updateKey) {
    clearPendingTerminalBrowserTabUpdate(entry);
    return;
  }

  const now = Date.now();
  const elapsed = now - entry.lastSentUpdateAt;
  const delay = Math.max(0, TERMINAL_BROWSER_TAB_UPDATE_THROTTLE_MS - elapsed);

  if (delay === 0) {
    clearPendingTerminalBrowserTabUpdate(entry);
    commitTerminalBrowserTabUpdate(win, entry, update, updateKey);
    return;
  }

  if (entry.pendingUpdate?.updateKey === updateKey) {
    return;
  }
  entry.pendingUpdate = { update, updateKey };
  if (entry.pendingUpdateTimer) {
    return;
  }
  entry.pendingUpdateTimer = setTimeout(() => {
    entry.pendingUpdateTimer = null;
    const pendingUpdate = entry.pendingUpdate;
    entry.pendingUpdate = null;
    if (!pendingUpdate) {
      return;
    }
    commitTerminalBrowserTabUpdate(
      win,
      entry,
      pendingUpdate.update,
      pendingUpdate.updateKey,
    );
  }, delay);
}

export function sendTerminalBrowserTabUpdate(
  win: BrowserWindow,
  tabId: string,
  entry: TerminalBrowserEntry,
  loading = entry.view.webContents.isLoading(),
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    return;
  }
  if (entry.view.webContents.isDestroyed()) {
    return;
  }
  const snapshot = getTerminalBrowserSnapshot(entry.view, entry.lastKnownUrl);
  if (snapshot.url) {
    entry.lastKnownUrl = snapshot.url;
  }
  const update: TerminalBrowserUpdate = {
    tabId,
    browserGroupId: entry.browserGroupId,
    ...snapshot,
    loading,
    cdpProxyAttached: entry.cdpProxyAttached,
    mcpActivityUntil: entry.mcpActivityUntil,
    devtoolsOpen: entry.devtoolsOpen,
    deviceState: getTerminalBrowserDeviceState(entry),
    displayScale: entry.displayScale,
  };
  queueTerminalBrowserTabUpdate(
    win,
    entry,
    update,
    getTerminalBrowserUpdateKey(update),
  );
}

export function sendTerminalBrowserTabActivatedFromProxy(
  win: BrowserWindow,
  tabId: string,
  entry: TerminalBrowserEntry,
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    return;
  }
  if (entry.view.webContents.isDestroyed()) {
    return;
  }
  const snapshot = getTerminalBrowserSnapshot(entry.view, entry.lastKnownUrl);
  if (snapshot.url) {
    entry.lastKnownUrl = snapshot.url;
  }
  const update: TerminalBrowserUpdate = {
    tabId,
    browserGroupId: entry.browserGroupId,
    ...snapshot,
    loading: entry.view.webContents.isLoading(),
    cdpProxyAttached: entry.cdpProxyAttached,
    mcpActivityUntil: entry.mcpActivityUntil,
    devtoolsOpen: entry.devtoolsOpen,
    deviceState: getTerminalBrowserDeviceState(entry),
    displayScale: entry.displayScale,
  };
  win.webContents.send("terminal-browser:tab-activated-from-proxy", update);
}

export function clearTerminalBrowserAnnotationAndNotify(
  win: BrowserWindow,
  tabId: string,
): void {
  clearTerminalBrowserAnnotation(getTerminalBrowserKey(win, tabId));
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    return;
  }
  win.webContents.send("terminal-browser:annotation-updated", {
    tabId,
    state: { active: false, annotations: [] },
  });
}
