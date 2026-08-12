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
import {
  assertTerminalBrowserWorkspaceIntegrity,
  getOrderedTerminalBrowserTabIds,
  getTerminalBrowserGroups,
} from "./terminal-browser-workspace.js";

export function getLiveTerminalBrowserTabIds(windowId: number): string[] {
  return getOrderedTerminalBrowserTabIds(windowId).filter((tabId) => {
    const entry = terminalBrowserRuntime.entries.get(
      getTerminalBrowserKey(windowId, tabId),
    );
    return Boolean(entry && !entry.view.webContents.isDestroyed());
  });
}

export function reconcileTerminalBrowserTabOrder(windowId: number): string[] {
  assertTerminalBrowserWorkspaceIntegrity(windowId);
  return getLiveTerminalBrowserTabIds(windowId);
}

export function getTerminalBrowserPersistedState(): TerminalBrowserPersistedState {
  const windowIds = [...terminalBrowserRuntime.workspaceByWindowId.keys()];
  const rawTabIds = new Map<string, number>();
  for (const windowId of windowIds) {
    for (const tabId of getLiveTerminalBrowserTabIds(windowId)) {
      rawTabIds.set(tabId, (rawTabIds.get(tabId) ?? 0) + 1);
    }
  }

  const tabs: TerminalBrowserPersistedTabRecord[] = [];
  const groups: TerminalBrowserPersistedState["groups"] = [];
  const persistedGroupIdSet = new Set<string>();
  let activeRecord: { persistedTabId: string; lastActiveAt: number } | null = null;

  for (const windowId of windowIds) {
    assertTerminalBrowserWorkspaceIntegrity(windowId);
    for (const group of getTerminalBrowserGroups(windowId)) {
      const persistedGroupId = persistedGroupIdSet.has(group.id)
        ? `${windowId}-${group.id}`
        : group.id;
      persistedGroupIdSet.add(persistedGroupId);
      const groupTabIds: string[] = [];
      for (const tabId of group.tabIds) {
        const entry = terminalBrowserRuntime.entries.get(
          getTerminalBrowserKey(windowId, tabId),
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
        const persistedTabId =
          (rawTabIds.get(tabId) ?? 0) > 1 ? `${windowId}-${tabId}` : tabId;
        groupTabIds.push(persistedTabId);
        tabs.push({
          id: persistedTabId,
          url,
          title: webContents.getTitle(),
          lastActiveAt: entry.lastActiveAt,
          browserGroupId: persistedGroupId,
        });
        if (
          terminalBrowserRuntime.attachedByWindowId.get(windowId) === tabId &&
          (!activeRecord || entry.lastActiveAt > activeRecord.lastActiveAt)
        ) {
          activeRecord = { persistedTabId, lastActiveAt: entry.lastActiveAt };
        }
      }
      if (groupTabIds.length > 0) {
        groups.push({
          id: persistedGroupId,
          name: group.name,
          nameOrigin: group.nameOrigin,
          tabIds: groupTabIds,
        });
      }
    }
  }

  const activeTabId =
    activeRecord && tabs.some((tab) => tab.id === activeRecord.persistedTabId)
      ? activeRecord.persistedTabId
      : (tabs[0]?.id ?? null);
  return { version: 2, activeTabId, groups, tabs };
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
