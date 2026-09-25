import { hideTerminalBrowserPresentation, selectTerminalBrowserPresentation, isTerminalBrowserPresentationBorrowed } from "./presentation.js";
import type { BrowserWindow, WebContentsView } from "electron";
import {
  findTerminalBrowserEntryForWindow,
  getTerminalBrowserWorkspaceKey,
  terminalBrowserRuntime,
} from "../runtime.js";
import { scheduleTerminalBrowserTabsSave } from "../tabs/index.js";
import { sendTerminalBrowserWorkspaceChanged } from "../workspace/index.js";
import { recordBrowserTabEvent } from "../../activity/emitter.js";

export function detachTerminalBrowser(
  win: BrowserWindow,
  tabId?: string,
): void {
  if (!tabId) {
    hideTerminalBrowserPresentation(win);
  } else {
    const entry = findTerminalBrowserEntryForWindow(win, tabId)?.entry;
    if (entry) hideTerminalBrowserPresentation(win, entry);
  }
}

export function attachTerminalBrowser(
  win: BrowserWindow,
  tabId: string,
  _view: WebContentsView,
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
    selectTerminalBrowserPresentation(win, entry);
    return;
  }
  if (!entry.attached && !isTerminalBrowserPresentationBorrowed(entry)) {
    win.contentView.addChildView(entry.viewportView);
    entry.attached = true;
  }
  selectTerminalBrowserPresentation(win, entry);
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
