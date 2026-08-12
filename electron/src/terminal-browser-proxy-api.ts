import { BrowserWindow, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { setTerminalBrowserDisplayScale } from "./terminal-browser-display-scale.js";
import {
  getTerminalBrowserKey,
  terminalBrowserRuntime,
  type TerminalBrowserCdpTarget,
  type TerminalBrowserEntry,
} from "./terminal-browser-runtime.js";
import {
  attachTerminalBrowser,
  closeTerminalBrowserEntry,
  getOrCreateTerminalBrowserView,
  validateTerminalBrowserUrl,
} from "./terminal-browser-view-lifecycle.js";
import {
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

export function getTerminalBrowserDisplayScaleForTarget(
  targetId: string,
): number | null {
  return getTerminalBrowserEntryByTargetId(targetId)?.entry.displayScale ?? null;
}

export async function setTerminalBrowserDisplayScaleForTarget(
  targetId: string,
  factor: unknown,
): Promise<{ factor: number } | null> {
  const found = getTerminalBrowserEntryByTargetId(targetId);
  if (!found) {
    return null;
  }
  const result = await setTerminalBrowserDisplayScale(found.entry, factor);
  const parts = found.key.split(":");
  const windowId = Number(parts[0]);
  const tabId = parts.slice(1).join(":");
  const win = BrowserWindow.fromId(windowId);
  if (win) {
    sendTerminalBrowserTabUpdate(win, tabId, found.entry);
  }
  return result;
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
