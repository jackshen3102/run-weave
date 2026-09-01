import type { BrowserWindow } from "electron";
import { TERMINAL_BROWSER_PROFILE_IDS } from "@runweave/shared/terminal-browser-profile";
import { readTerminalBrowserPersistedState } from "./terminal-browser-tabs-persistence.js";
import { selectTerminalBrowserStateForRestore } from "./terminal-browser-tabs-state.js";
import {
  getTerminalBrowserKey,
  getTerminalBrowserWorkspaceKey,
  terminalBrowserRuntime,
} from "./terminal-browser-runtime.js";
import {
  ensureTerminalBrowserDormantFallback,
  registerTerminalBrowserTab,
  setTerminalBrowserGroupMetadata,
} from "./terminal-browser-workspace.js";

/**
 * Restore only workspace metadata. Browser views and navigation are created on
 * the first explicit use of an individual Profile after its route is ready.
 */
export async function restoreTerminalBrowserTabsForWindow(
  win: BrowserWindow,
): Promise<void> {
  if (terminalBrowserRuntime.persistedStateRestored) {
    return;
  }
  terminalBrowserRuntime.persistedStateRestored = true;
  const state = await readTerminalBrowserPersistedState();

  for (const profileId of TERMINAL_BROWSER_PROFILE_IDS) {
    const workspaceKey = getTerminalBrowserWorkspaceKey(win.id, profileId);
    terminalBrowserRuntime.restoringWorkspaceKeys.add(workspaceKey);
    try {
      const restored = selectTerminalBrowserStateForRestore(
        state.profiles[profileId],
      );
      const tabsById = new Map(restored.tabs.map((tab) => [tab.id, tab]));
      for (const group of restored.groups) {
        let openerTabId: string | undefined;
        for (const tabId of group.tabIds) {
          const tab = tabsById.get(tabId);
          if (!tab) {
            continue;
          }
          const key = getTerminalBrowserKey(win.id, profileId, tab.id);
          terminalBrowserRuntime.dormantTabs.set(key, {
            windowId: win.id,
            profileId,
            tabId: tab.id,
            browserGroupId: group.id,
            url: tab.url,
            title: tab.title,
            lastActiveAt: tab.lastActiveAt,
          });
          registerTerminalBrowserTab(
            win.id,
            profileId,
            tab.id,
            group.id,
            openerTabId,
          );
          openerTabId = tab.id;
        }
        setTerminalBrowserGroupMetadata(
          win.id,
          profileId,
          group.id,
          group.name,
          group.nameOrigin,
        );
      }
      const activeTabId =
        restored.activeTabId && tabsById.has(restored.activeTabId)
          ? restored.activeTabId
          : (restored.tabs[0]?.id ?? null);
      if (activeTabId) {
        terminalBrowserRuntime.attachedByWorkspaceKey.set(
          workspaceKey,
          activeTabId,
        );
      } else {
        ensureTerminalBrowserDormantFallback(win.id, profileId);
      }
    } finally {
      terminalBrowserRuntime.restoringWorkspaceKeys.delete(workspaceKey);
    }
  }
}
