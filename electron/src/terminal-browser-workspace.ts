import { BrowserWindow } from "electron";
import type {
  TerminalBrowserGroupNameOrigin,
  TerminalBrowserStateChangedEvent,
  TerminalBrowserWorkspaceSnapshot,
} from "@runweave/shared/terminal-browser-workspace";
import { getTerminalBrowserDeviceState } from "./terminal-browser-device-emulation.js";
import {
  getTerminalBrowserKey,
  terminalBrowserRuntime,
  type TerminalBrowserGroupRecord,
  type TerminalBrowserWindowWorkspace,
} from "./terminal-browser-runtime.js";

export const TERMINAL_BROWSER_PLACEHOLDER_GROUP_NAME = "新工作组";
export const TERMINAL_BROWSER_MAX_GROUP_NAME_LENGTH = 40;

function getOrCreateWindowWorkspace(
  windowId: number,
): TerminalBrowserWindowWorkspace {
  const existing = terminalBrowserRuntime.workspaceByWindowId.get(windowId);
  if (existing) {
    return existing;
  }
  const workspace: TerminalBrowserWindowWorkspace = {
    revision: 0,
    groups: [],
  };
  terminalBrowserRuntime.workspaceByWindowId.set(windowId, workspace);
  return workspace;
}

export function normalizeTerminalBrowserGroupName(name: unknown): string | null {
  if (typeof name !== "string") {
    return null;
  }
  const normalized = name.trim();
  const length = Array.from(normalized).length;
  return length >= 1 && length <= TERMINAL_BROWSER_MAX_GROUP_NAME_LENGTH
    ? normalized
    : null;
}

function truncateGroupName(name: string): string {
  return Array.from(name)
    .slice(0, TERMINAL_BROWSER_MAX_GROUP_NAME_LENGTH)
    .join("");
}

export function deriveTerminalBrowserAutomaticGroupName(
  title: string,
  url: string,
): string | null {
  const normalizedTitle = title.trim();
  const normalizedUrl = url === "about:blank" ? "" : url.trim();
  const titleIsUrl = (() => {
    if (!normalizedTitle) {
      return false;
    }
    try {
      return new URL(normalizedTitle).toString() === new URL(normalizedUrl).toString();
    } catch {
      return normalizedTitle === normalizedUrl;
    }
  })();
  if (
    normalizedTitle &&
    normalizedTitle !== "about:blank" &&
    !titleIsUrl
  ) {
    return truncateGroupName(normalizedTitle);
  }
  if (!normalizedUrl) {
    return null;
  }
  try {
    const hostname = new URL(normalizedUrl).hostname.trim();
    return hostname ? truncateGroupName(hostname) : null;
  } catch {
    return null;
  }
}

export function getTerminalBrowserGroups(
  windowId: number,
): TerminalBrowserGroupRecord[] {
  return getOrCreateWindowWorkspace(windowId).groups;
}

export function getTerminalBrowserGroup(
  windowId: number,
  groupId: string,
): TerminalBrowserGroupRecord | null {
  return (
    getOrCreateWindowWorkspace(windowId).groups.find(
      (group) => group.id === groupId,
    ) ?? null
  );
}

export function setTerminalBrowserGroupMetadata(
  windowId: number,
  groupId: string,
  name: string,
  nameOrigin: TerminalBrowserGroupNameOrigin,
): void {
  const group = getTerminalBrowserGroup(windowId, groupId);
  const normalizedName = normalizeTerminalBrowserGroupName(name);
  if (!group || !normalizedName) {
    throw new Error("Invalid terminal browser group metadata");
  }
  group.name = normalizedName;
  group.nameOrigin = nameOrigin;
}

export function registerTerminalBrowserTab(
  windowId: number,
  tabId: string,
  browserGroupId: string,
  openerTabId?: string,
): void {
  const workspace = getOrCreateWindowWorkspace(windowId);
  for (const group of workspace.groups) {
    group.tabIds = group.tabIds.filter((memberId) => memberId !== tabId);
  }
  let group = workspace.groups.find((candidate) => candidate.id === browserGroupId);
  if (!group) {
    group = {
      id: browserGroupId,
      name: TERMINAL_BROWSER_PLACEHOLDER_GROUP_NAME,
      nameOrigin: "placeholder",
      tabIds: [],
    };
    workspace.groups.push(group);
  }
  const openerIndex = openerTabId ? group.tabIds.indexOf(openerTabId) : -1;
  if (openerIndex >= 0) {
    group.tabIds.splice(openerIndex + 1, 0, tabId);
  } else {
    group.tabIds.push(tabId);
  }
  workspace.groups = workspace.groups.filter((candidate) => candidate.tabIds.length > 0);
  assertTerminalBrowserWorkspaceIntegrity(windowId);
}

export function removeTerminalBrowserTabFromWorkspace(
  windowId: number,
  tabId: string,
): void {
  const workspace = getOrCreateWindowWorkspace(windowId);
  workspace.groups = workspace.groups
    .map((group) => ({
      ...group,
      tabIds: group.tabIds.filter((memberId) => memberId !== tabId),
    }))
    .filter((group) => group.tabIds.length > 0);
}

export function reorderTerminalBrowserGroupTabs(
  windowId: number,
  groupId: string,
  orderedTabIds: string[],
): void {
  const group = getTerminalBrowserGroup(windowId, groupId);
  if (!group) {
    throw new Error("Unknown terminal browser group");
  }
  const candidateIds = orderedTabIds.filter(
    (tabId): tabId is string => typeof tabId === "string",
  );
  const candidateSet = new Set(candidateIds);
  const memberSet = new Set(group.tabIds);
  const valid =
    candidateIds.length === orderedTabIds.length &&
    candidateIds.length === group.tabIds.length &&
    candidateSet.size === candidateIds.length &&
    candidateIds.every((tabId) => memberSet.has(tabId));
  if (!valid) {
    throw new Error("Invalid terminal browser group tab order");
  }
  group.tabIds = [...candidateIds];
  assertTerminalBrowserWorkspaceIntegrity(windowId);
}

export function renameTerminalBrowserGroup(
  windowId: number,
  groupId: string,
  name: unknown,
): void {
  const group = getTerminalBrowserGroup(windowId, groupId);
  const normalizedName = normalizeTerminalBrowserGroupName(name);
  if (!group || !normalizedName) {
    throw new Error("Invalid terminal browser group name");
  }
  group.name = normalizedName;
  group.nameOrigin = "user";
}

export function maybeAutomaticallyNameTerminalBrowserGroup(
  windowId: number,
  groupId: string,
  title: string,
  url: string,
): boolean {
  const group = getTerminalBrowserGroup(windowId, groupId);
  if (!group || group.nameOrigin !== "placeholder") {
    return false;
  }
  const name = deriveTerminalBrowserAutomaticGroupName(title, url);
  if (!name) {
    return false;
  }
  group.name = name;
  group.nameOrigin = "automatic";
  return true;
}

export function getOrderedTerminalBrowserTabIds(windowId: number): string[] {
  return getOrCreateWindowWorkspace(windowId).groups.flatMap(
    (group) => group.tabIds,
  );
}

export function getTerminalBrowserWorkspaceSnapshot(
  windowId: number,
): TerminalBrowserWorkspaceSnapshot {
  const workspace = getOrCreateWindowWorkspace(windowId);
  const activeTabId = terminalBrowserRuntime.attachedByWindowId.get(windowId) ?? "";
  const tabs = getOrderedTerminalBrowserTabIds(windowId).flatMap((tabId) => {
    const entry = terminalBrowserRuntime.entries.get(
      getTerminalBrowserKey(windowId, tabId),
    );
    const webContents = entry?.view.webContents;
    if (!entry || !webContents || webContents.isDestroyed()) {
      return [];
    }
    const history = webContents.navigationHistory;
    const url = webContents.getURL() || entry.lastKnownUrl;
    return [
      {
        tabId,
        browserGroupId: entry.browserGroupId,
        url,
        title: webContents.getTitle(),
        canGoBack: history.canGoBack(),
        canGoForward: history.canGoForward(),
        loading: webContents.isLoading(),
        active: activeTabId === tabId,
        cdpProxyAttached: entry.cdpProxyAttached,
        mcpActivityUntil: entry.mcpActivityUntil,
        devtoolsOpen: entry.devtoolsOpen,
        deviceState: getTerminalBrowserDeviceState(entry),
        displayScale: entry.displayScale,
        faviconDataUrl: entry.faviconDataUrl,
        navigationError: entry.navigationError,
      },
    ];
  });
  return {
    revision: workspace.revision,
    activeTabId:
      activeTabId && tabs.some((tab) => tab.tabId === activeTabId)
        ? activeTabId
        : (tabs[0]?.tabId ?? ""),
    groups: workspace.groups.map((group) => ({
      id: group.id,
      name: group.name,
      nameOrigin: group.nameOrigin,
      tabIds: [...group.tabIds],
    })),
    tabs,
  };
}

export function nextTerminalBrowserRevision(windowId: number): number {
  const workspace = getOrCreateWindowWorkspace(windowId);
  workspace.revision += 1;
  return workspace.revision;
}

export function sendTerminalBrowserWorkspaceChanged(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    return;
  }
  const revision = nextTerminalBrowserRevision(win.id);
  const workspace = getTerminalBrowserWorkspaceSnapshot(win.id);
  const event: TerminalBrowserStateChangedEvent = {
    kind: "workspace",
    revision,
    workspace,
  };
  win.webContents.send("terminal-browser:state-changed", event);
}

export function clearTerminalBrowserWorkspace(windowId: number): void {
  terminalBrowserRuntime.workspaceByWindowId.delete(windowId);
}

export function assertTerminalBrowserWorkspaceIntegrity(windowId: number): void {
  const workspace = getOrCreateWindowWorkspace(windowId);
  const groupIds = new Set<string>();
  const tabIds = new Set<string>();
  for (const group of workspace.groups) {
    if (!group.id || groupIds.has(group.id) || group.tabIds.length === 0) {
      throw new Error("Invalid terminal browser workspace group");
    }
    groupIds.add(group.id);
    for (const tabId of group.tabIds) {
      if (tabIds.has(tabId)) {
        throw new Error("Duplicate terminal browser workspace tab");
      }
      const entry = terminalBrowserRuntime.entries.get(
        getTerminalBrowserKey(windowId, tabId),
      );
      if (!entry || entry.browserGroupId !== group.id) {
        throw new Error("Terminal browser workspace membership mismatch");
      }
      tabIds.add(tabId);
    }
  }
  for (const [key, entry] of terminalBrowserRuntime.entries) {
    if (entry.windowId !== windowId || entry.view.webContents.isDestroyed()) {
      continue;
    }
    const tabId = key.slice(`${windowId}:`.length);
    if (!tabIds.has(tabId)) {
      throw new Error("Live terminal browser tab missing from workspace");
    }
  }
}
