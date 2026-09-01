import type { BrowserWindow, WebContentsView } from "electron";
import {
  findTerminalBrowserEntryForWindow,
  getTerminalBrowserWorkspaceKey,
  terminalBrowserRuntime,
} from "./terminal-browser-runtime.js";
import { scheduleTerminalBrowserTabsSave } from "./terminal-browser-tabs.js";
import { sendTerminalBrowserWorkspaceChanged } from "./terminal-browser-workspace.js";
import { recordBrowserTabEvent } from "./activity-emitter.js";

export function detachTerminalBrowser(
  win: BrowserWindow,
  tabId?: string,
): void {
  if (!tabId) {
    for (const entry of terminalBrowserRuntime.entries.values()) {
      if (entry.windowId === win.id) {
        entry.view.setVisible(false);
        entry.visible = false;
      }
    }
    return;
  }
  const found = findTerminalBrowserEntryForWindow(win, tabId);
  if (found) {
    found.entry.view.setVisible(false);
    found.entry.visible = false;
  }
}

export function attachTerminalBrowser(
  win: BrowserWindow,
  tabId: string,
  view: WebContentsView,
  options: { emitWorkspace?: boolean; persist?: boolean } = {},
): void {
  const entry = findTerminalBrowserEntryForWindow(win, tabId)?.entry;
  if (!entry) {
    return;
  }
  const workspaceKey = getTerminalBrowserWorkspaceKey(win.id, entry.profileId);
  const attachedTabId =
    terminalBrowserRuntime.attachedByWorkspaceKey.get(workspaceKey);
  if (attachedTabId === tabId && entry.attached) {
    view.setVisible(true);
    entry.visible = true;
    return;
  }
  for (const candidate of terminalBrowserRuntime.entries.values()) {
    if (candidate.windowId === win.id) {
      candidate.view.setVisible(false);
      candidate.visible = false;
    }
  }
  if (!entry.attached) {
    win.contentView.addChildView(view);
    entry.attached = true;
  }
  view.setVisible(true);
  entry.visible = true;
  terminalBrowserRuntime.attachedByWorkspaceKey.set(workspaceKey, tabId);
  entry.lastActiveAt = Date.now();
  recordBrowserTabEvent({
    eventName: "browser.tab.activated",
    tabId,
    browserGroupId: entry.browserGroupId,
    reason: "selected",
  });
  if (options.emitWorkspace !== false) {
    sendTerminalBrowserWorkspaceChanged(win, entry.profileId);
  }
  if (
    options.persist !== false &&
    !terminalBrowserRuntime.restoringWorkspaceKeys.has(workspaceKey)
  ) {
    scheduleTerminalBrowserTabsSave();
  }
}
