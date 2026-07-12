import type {
  TerminalBrowserPersistedState,
  TerminalBrowserPersistedTabRecord,
} from "./terminal-browser-tabs-state.js";
import { normalizeTerminalBrowserUrlForStorage } from "./terminal-browser-tabs-state.js";
import { writeTerminalBrowserPersistedState } from "./terminal-browser-tabs-persistence.js";
import {
  getTerminalBrowserKey,
  terminalBrowserRuntime,
} from "./terminal-browser-runtime.js";

export function getLiveTerminalBrowserTabIds(windowId: number): string[] {
  const prefix = `${windowId}:`;
  const liveTabIds: string[] = [];
  for (const [key, entry] of terminalBrowserRuntime.entries) {
    const webContents = entry.view.webContents;
    if (
      entry.windowId === windowId &&
      key.startsWith(prefix) &&
      webContents &&
      !webContents.isDestroyed()
    ) {
      liveTabIds.push(key.slice(prefix.length));
    }
  }
  return liveTabIds;
}

export function reconcileTerminalBrowserTabOrder(windowId: number): string[] {
  const liveTabIds = getLiveTerminalBrowserTabIds(windowId);
  const liveTabIdSet = new Set(liveTabIds);
  const nextOrder = (
    terminalBrowserRuntime.tabOrderByWindowId.get(windowId) ?? []
  ).filter((tabId) => liveTabIdSet.has(tabId));
  const orderedTabIdSet = new Set(nextOrder);
  for (const tabId of liveTabIds) {
    if (!orderedTabIdSet.has(tabId)) {
      nextOrder.push(tabId);
      orderedTabIdSet.add(tabId);
    }
  }
  terminalBrowserRuntime.tabOrderByWindowId.set(windowId, nextOrder);
  return nextOrder;
}

export function insertTerminalBrowserTabOrder(
  windowId: number,
  tabId: string,
  openerTabId?: string,
): void {
  const nextOrder = reconcileTerminalBrowserTabOrder(windowId).filter(
    (orderedTabId) => orderedTabId !== tabId,
  );
  const openerIndex = openerTabId ? nextOrder.indexOf(openerTabId) : -1;
  if (openerIndex >= 0) {
    nextOrder.splice(openerIndex + 1, 0, tabId);
  } else {
    nextOrder.push(tabId);
  }
  terminalBrowserRuntime.tabOrderByWindowId.set(windowId, nextOrder);
}

export function removeTerminalBrowserTabOrder(
  windowId: number,
  tabId: string,
): void {
  const nextOrder = (
    terminalBrowserRuntime.tabOrderByWindowId.get(windowId) ?? []
  ).filter((orderedTabId) => orderedTabId !== tabId);
  terminalBrowserRuntime.tabOrderByWindowId.set(windowId, nextOrder);
}

export function getTerminalBrowserTabRecords(): TerminalBrowserPersistedTabRecord[] {
  const rawRecords: Array<
    TerminalBrowserPersistedTabRecord & { windowId: number }
  > = [];
  const idCounts = new Map<string, number>();

  const windowIds = new Set<number>();
  for (const entry of terminalBrowserRuntime.entries.values()) {
    windowIds.add(entry.windowId);
  }
  for (const windowId of windowIds) {
    for (const id of reconcileTerminalBrowserTabOrder(windowId)) {
      const entry = terminalBrowserRuntime.entries.get(
        getTerminalBrowserKey(windowId, id),
      );
      const webContents = entry?.view.webContents;
      if (!entry || !webContents || webContents.isDestroyed()) {
        continue;
      }
      const url = normalizeTerminalBrowserUrlForStorage(
        webContents.getURL() || entry.lastKnownUrl,
      );
      if (!url) {
        continue;
      }
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
      rawRecords.push({
        id,
        windowId,
        url,
        title: webContents.getTitle(),
        lastActiveAt: entry.lastActiveAt,
        browserGroupId: entry.browserGroupId,
      });
    }
  }

  return rawRecords.map(({ windowId, ...record }) => ({
    ...record,
    id:
      (idCounts.get(record.id) ?? 0) > 1
        ? `${windowId}-${record.id}`
        : record.id,
  }));
}

export function getTerminalBrowserPersistedState(): TerminalBrowserPersistedState {
  let activeRecord: {
    windowId: number;
    tabId: string;
    lastActiveAt: number;
  } | null = null;
  for (const [windowId, tabId] of terminalBrowserRuntime.attachedByWindowId) {
    const entry = terminalBrowserRuntime.entries.get(
      getTerminalBrowserKey(windowId, tabId),
    );
    if (!entry) {
      continue;
    }
    if (!activeRecord || entry.lastActiveAt > activeRecord.lastActiveAt) {
      activeRecord = { windowId, tabId, lastActiveAt: entry.lastActiveAt };
    }
  }

  const tabs = getTerminalBrowserTabRecords();
  const activeTabId = activeRecord
    ? (tabs.find((tab) => tab.id === activeRecord.tabId)?.id ??
      tabs.find(
        (tab) => tab.id === `${activeRecord.windowId}-${activeRecord.tabId}`,
      )?.id ??
      null)
    : null;

  return {
    version: 1,
    activeTabId:
      activeTabId && tabs.some((tab) => tab.id === activeTabId)
        ? activeTabId
        : (tabs[0]?.id ?? null),
    tabs,
  };
}

export function scheduleTerminalBrowserTabsSave(): void {
  if (terminalBrowserRuntime.restoringWindows.size > 0) {
    return;
  }
  if (terminalBrowserRuntime.saveTimer) {
    clearTimeout(terminalBrowserRuntime.saveTimer);
  }
  terminalBrowserRuntime.saveTimer = setTimeout(() => {
    terminalBrowserRuntime.saveTimer = null;
    const state = getTerminalBrowserPersistedState();
    void writeTerminalBrowserPersistedState(state).catch(() => {
      // Persistence failure should not break the embedded browser.
    });
  }, 150);
}
