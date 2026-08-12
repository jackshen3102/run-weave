import type { BrowserWindow } from "electron";
import { readTerminalBrowserPersistedState } from "./terminal-browser-tabs-persistence.js";
import { selectTerminalBrowserStateForRestore } from "./terminal-browser-tabs-state.js";
import {
  getTerminalBrowserKey,
  terminalBrowserRuntime,
} from "./terminal-browser-runtime.js";
import {
  getOrderedTerminalBrowserTabIds,
  setTerminalBrowserGroupMetadata,
} from "./terminal-browser-workspace.js";
import {
  attachTerminalBrowser,
  ensureTerminalBrowserFallback,
  getOrCreateTerminalBrowserView,
} from "./terminal-browser-view-lifecycle.js";
import { sendTerminalBrowserTabUpdate } from "./terminal-browser-view-updates.js";

export async function restoreTerminalBrowserTabsForWindow(
  win: BrowserWindow,
): Promise<void> {
  if (terminalBrowserRuntime.persistedStateRestored) {
    return;
  }
  terminalBrowserRuntime.persistedStateRestored = true;
  if (getOrderedTerminalBrowserTabIds(win.id).length > 0) {
    return;
  }

  const state = await readTerminalBrowserPersistedState();
  terminalBrowserRuntime.restoringWindows.add(win.id);
  try {
    const restoredState = selectTerminalBrowserStateForRestore(state);
    const tabsById = new Map(restoredState.tabs.map((tab) => [tab.id, tab]));
    for (const group of restoredState.groups) {
      let openerTabId: string | undefined;
      for (const tabId of group.tabIds) {
        const tab = tabsById.get(tabId);
        if (!tab) {
          continue;
        }
        const view = getOrCreateTerminalBrowserView(win, tab.id, {
          browserGroupId: group.id,
          openerTabId,
          notifyWorkspace: false,
        });
        const entry = terminalBrowserRuntime.entries.get(
          getTerminalBrowserKey(win, tab.id),
        );
        if (!entry) {
          continue;
        }
        openerTabId = tab.id;
        entry.lastActiveAt = tab.lastActiveAt;
        entry.lastKnownUrl = tab.url;
        void view.webContents.loadURL(tab.url).catch(() => {
          sendTerminalBrowserTabUpdate(win, tab.id, entry, false);
        });
      }
      setTerminalBrowserGroupMetadata(
        win.id,
        group.id,
        group.name,
        group.nameOrigin,
      );
    }

    const activeTabId =
      restoredState.activeTabId &&
      restoredState.tabs.some((tab) => tab.id === restoredState.activeTabId)
        ? restoredState.activeTabId
        : (restoredState.tabs[0]?.id ?? null);
    if (activeTabId) {
      const activeEntry = terminalBrowserRuntime.entries.get(
        getTerminalBrowserKey(win, activeTabId),
      );
      if (activeEntry) {
        attachTerminalBrowser(win, activeTabId, activeEntry.view, {
          emitWorkspace: false,
          persist: false,
        });
      }
    } else {
      ensureTerminalBrowserFallback(win, { emitWorkspace: false });
    }
  } finally {
    terminalBrowserRuntime.restoringWindows.delete(win.id);
  }
}
