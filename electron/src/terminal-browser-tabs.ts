import {
  TERMINAL_BROWSER_PROFILE_IDS,
  type TerminalBrowserProfileId,
} from "@runweave/shared/terminal-browser-profile";
import type {
  TerminalBrowserPersistedProfileState,
  TerminalBrowserPersistedState,
  TerminalBrowserPersistedTabRecord,
} from "./terminal-browser-tabs-state.js";
import {
  createEmptyTerminalBrowserPersistedState,
  normalizeTerminalBrowserUrlForStorage,
} from "./terminal-browser-tabs-state.js";
import { writeTerminalBrowserPersistedState } from "./terminal-browser-tabs-persistence.js";
import {
  getTerminalBrowserKey,
  getTerminalBrowserWorkspaceKey,
  terminalBrowserRuntime,
} from "./terminal-browser-runtime.js";
import {
  assertTerminalBrowserWorkspaceIntegrity,
  getOrderedTerminalBrowserTabIds,
  getTerminalBrowserGroups,
} from "./terminal-browser-workspace.js";

export function getLiveTerminalBrowserTabIds(
  windowId: number,
  profileId: TerminalBrowserProfileId,
): string[] {
  return getOrderedTerminalBrowserTabIds(windowId, profileId).filter(
    (tabId) => {
      const entry = terminalBrowserRuntime.entries.get(
        getTerminalBrowserKey(windowId, profileId, tabId),
      );
      return Boolean(entry && !entry.view.webContents.isDestroyed());
    },
  );
}

export function reconcileTerminalBrowserTabOrder(
  windowId: number,
  profileId: TerminalBrowserProfileId,
): string[] {
  assertTerminalBrowserWorkspaceIntegrity(windowId, profileId);
  return getOrderedTerminalBrowserTabIds(windowId, profileId);
}

function getWorkspaceWindowIds(profileId: TerminalBrowserProfileId): number[] {
  const windowIds = new Set<number>();
  for (const [key, workspace] of terminalBrowserRuntime.workspaceByKey) {
    if (workspace.profileId !== profileId) {
      continue;
    }
    const windowId = Number(key.split(":", 1)[0]);
    if (Number.isInteger(windowId)) {
      windowIds.add(windowId);
    }
  }
  return [...windowIds];
}

function buildPersistedProfileState(
  profileId: TerminalBrowserProfileId,
): TerminalBrowserPersistedProfileState {
  const windowIds = getWorkspaceWindowIds(profileId);
  const rawTabIds = new Map<string, number>();
  for (const windowId of windowIds) {
    for (const tabId of getOrderedTerminalBrowserTabIds(windowId, profileId)) {
      rawTabIds.set(tabId, (rawTabIds.get(tabId) ?? 0) + 1);
    }
  }

  const tabs: TerminalBrowserPersistedTabRecord[] = [];
  const groups: TerminalBrowserPersistedProfileState["groups"] = [];
  const persistedGroupIdSet = new Set<string>();
  let activeRecord: { persistedTabId: string; lastActiveAt: number } | null =
    null;

  for (const windowId of windowIds) {
    assertTerminalBrowserWorkspaceIntegrity(windowId, profileId);
    for (const group of getTerminalBrowserGroups(windowId, profileId)) {
      const persistedGroupId = persistedGroupIdSet.has(group.id)
        ? `${windowId}-${group.id}`
        : group.id;
      persistedGroupIdSet.add(persistedGroupId);
      const groupTabIds: string[] = [];
      for (const tabId of group.tabIds) {
        const key = getTerminalBrowserKey(windowId, profileId, tabId);
        const entry = terminalBrowserRuntime.entries.get(key);
        const dormant = terminalBrowserRuntime.dormantTabs.get(key);
        const webContents = entry?.view.webContents;
        const url = normalizeTerminalBrowserUrlForStorage(
          entry && webContents && !webContents.isDestroyed()
            ? webContents.getURL() || entry.lastKnownUrl
            : dormant?.url,
        );
        if (!url) {
          continue;
        }
        const persistedTabId =
          (rawTabIds.get(tabId) ?? 0) > 1 ? `${windowId}-${tabId}` : tabId;
        const lastActiveAt = entry?.lastActiveAt ?? dormant?.lastActiveAt ?? 0;
        groupTabIds.push(persistedTabId);
        tabs.push({
          id: persistedTabId,
          url,
          title:
            entry && webContents && !webContents.isDestroyed()
              ? webContents.getTitle()
              : (dormant?.title ?? ""),
          lastActiveAt,
          browserGroupId: persistedGroupId,
        });
        if (
          terminalBrowserRuntime.attachedByWorkspaceKey.get(
            getTerminalBrowserWorkspaceKey(windowId, profileId),
          ) === tabId &&
          (!activeRecord || lastActiveAt > activeRecord.lastActiveAt)
        ) {
          activeRecord = { persistedTabId, lastActiveAt };
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
  return { activeTabId, groups, tabs };
}

export function getTerminalBrowserPersistedState(): TerminalBrowserPersistedState {
  const state = createEmptyTerminalBrowserPersistedState();
  for (const profileId of TERMINAL_BROWSER_PROFILE_IDS) {
    state.profiles[profileId] = buildPersistedProfileState(profileId);
  }
  return state;
}

export function scheduleTerminalBrowserTabsSave(): void {
  if (terminalBrowserRuntime.restoringWorkspaceKeys.size > 0) {
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
