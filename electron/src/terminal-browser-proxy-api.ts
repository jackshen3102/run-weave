import { BrowserWindow, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { getTerminalBrowserDeviceState } from "./terminal-browser-device-emulation.js";
import {
  getTerminalBrowserKey,
  terminalBrowserRuntime,
  type TerminalBrowserCdpTarget,
  type TerminalBrowserEntry,
  type TerminalBrowserTabSnapshot,
} from "./terminal-browser-runtime.js";
import { reconcileTerminalBrowserTabOrder } from "./terminal-browser-tabs.js";
import {
  attachTerminalBrowser,
  closeTerminalBrowserEntry,
  getOrCreateTerminalBrowserView,
  validateTerminalBrowserUrl,
} from "./terminal-browser-view-lifecycle.js";
import {
  getTerminalBrowserSnapshot,
  sendTerminalBrowserTabActivatedFromProxy,
  sendTerminalBrowserTabUpdate,
} from "./terminal-browser-view-updates.js";

export function getTerminalBrowserCdpTargets(): TerminalBrowserCdpTarget[] {
  const targets: TerminalBrowserCdpTarget[] = [];
  for (const [key, entry] of terminalBrowserRuntime.entries) {
    const wc = entry.view.webContents;
    if (!wc || wc.isDestroyed()) {
      continue;
    }
    const tabId = key.split(":").slice(1).join(":");
    targets.push({
      key,
      targetId: entry.targetId,
      browserGroupId: entry.browserGroupId,
      windowId: entry.windowId,
      active:
        terminalBrowserRuntime.attachedByWindowId.get(entry.windowId) === tabId,
      lastActiveAt: entry.lastActiveAt,
      url: wc.getURL() || entry.lastKnownUrl,
      title: wc.getTitle(),
      webContents: wc,
    });
  }
  return targets.sort((left, right) => {
    if (left.active !== right.active) {
      return left.active ? -1 : 1;
    }
    return right.lastActiveAt - left.lastActiveAt;
  });
}

export function getTerminalBrowserEntryByTargetId(
  targetId: string,
): { key: string; entry: TerminalBrowserEntry } | null {
  for (const [key, entry] of terminalBrowserRuntime.entries) {
    if (entry.targetId === targetId) {
      return { key, entry };
    }
  }
  return null;
}

export function getTerminalBrowserEntryByKey(
  key: string,
): TerminalBrowserEntry | null {
  return terminalBrowserRuntime.entries.get(key) ?? null;
}

export function getTerminalBrowserTabsForWindow(
  windowId: number,
): TerminalBrowserTabSnapshot[] {
  const activeTabId =
    terminalBrowserRuntime.attachedByWindowId.get(windowId) ?? null;
  const tabs: TerminalBrowserTabSnapshot[] = [];
  for (const tabId of reconcileTerminalBrowserTabOrder(windowId)) {
    const entry = terminalBrowserRuntime.entries.get(
      getTerminalBrowserKey(windowId, tabId),
    );
    if (!entry || entry.view.webContents.isDestroyed()) {
      continue;
    }
    tabs.push({
      tabId,
      browserGroupId: entry.browserGroupId,
      ...getTerminalBrowserSnapshot(entry.view, entry.lastKnownUrl),
      loading: entry.view.webContents.isLoading(),
      active: activeTabId === tabId,
      cdpProxyAttached: entry.cdpProxyAttached,
      mcpActivityUntil: entry.mcpActivityUntil,
      devtoolsOpen: entry.devtoolsOpen,
      deviceState: getTerminalBrowserDeviceState(entry),
    });
  }
  return tabs;
}

export async function createTerminalBrowserTabFromProxy(
  windowId: number,
  url: string,
  browserGroupId?: string,
): Promise<{
  key: string;
  targetId: string;
  browserGroupId: string;
  webContents: WebContents;
} | null> {
  const win = BrowserWindow.fromId(windowId);
  if (!win) {
    return null;
  }
  const tabId = `ai-tab-${randomUUID().slice(0, 8)}`;
  const view = getOrCreateTerminalBrowserView(win, tabId, { browserGroupId });
  const key = getTerminalBrowserKey(windowId, tabId);
  const entry = terminalBrowserRuntime.entries.get(key);
  if (!entry) {
    return null;
  }

  attachTerminalBrowser(win, tabId, view);

  const safeUrl = validateTerminalBrowserUrl(url);
  if (safeUrl) {
    entry.lastKnownUrl = safeUrl;
    const load = view.webContents.loadURL(safeUrl);
    if (safeUrl === "about:blank") {
      await load;
    } else {
      void load.catch(() => {
        // The proxy target remains usable even if the initial navigation fails.
      });
    }
  }

  // Notify the renderer so the frontend tab bar picks up the new tab.
  win.webContents.send("terminal-browser:tab-created-from-proxy", {
    tabId,
    browserGroupId: entry.browserGroupId,
    url: safeUrl ?? url,
    title: "",
  });

  return {
    key,
    targetId: entry.targetId,
    browserGroupId: entry.browserGroupId,
    webContents: view.webContents,
  };
}

export function closeTerminalBrowserTabFromProxy(targetId: string): boolean {
  const found = getTerminalBrowserEntryByTargetId(targetId);
  if (!found) {
    return false;
  }
  const parts = found.key.split(":");
  const windowId = Number(parts[0]);
  const tabId = parts.slice(1).join(":");
  const win = BrowserWindow.fromId(windowId);
  if (!win) {
    return false;
  }
  closeTerminalBrowserEntry(win, tabId);
  return true;
}

export function activateTerminalBrowserTabFromProxy(targetId: string): boolean {
  const found = getTerminalBrowserEntryByTargetId(targetId);
  if (!found) {
    return false;
  }
  const parts = found.key.split(":");
  const windowId = Number(parts[0]);
  const tabId = parts.slice(1).join(":");
  const win = BrowserWindow.fromId(windowId);
  if (!win) {
    return false;
  }
  attachTerminalBrowser(win, tabId, found.entry.view);
  sendTerminalBrowserTabActivatedFromProxy(win, tabId, found.entry);
  return true;
}

export function setTerminalBrowserCdpProxyAttached(
  targetId: string,
  attached: boolean,
): void {
  const found = getTerminalBrowserEntryByTargetId(targetId);
  if (found) {
    found.entry.cdpProxyAttached = attached;
    const parts = found.key.split(":");
    const windowId = Number(parts[0]);
    const tabId = parts.slice(1).join(":");
    const win = BrowserWindow.fromId(windowId);
    if (win) {
      sendTerminalBrowserTabUpdate(win, tabId, found.entry);
    }
  }
}

export function markTerminalBrowserMcpActivity(targetId: string): void {
  const found = getTerminalBrowserEntryByTargetId(targetId);
  if (!found) {
    return;
  }
  found.entry.mcpActivityUntil = Date.now() + 4500;
  const parts = found.key.split(":");
  const windowId = Number(parts[0]);
  const tabId = parts.slice(1).join(":");
  const win = BrowserWindow.fromId(windowId);
  if (win) {
    sendTerminalBrowserTabUpdate(win, tabId, found.entry);
  }
}
