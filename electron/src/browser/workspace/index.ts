import { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
import type {
  TerminalBrowserGroupNameOrigin,
  TerminalBrowserStateChangedEvent,
  TerminalBrowserWorkspaceSnapshot,
} from "@runweave/shared/terminal-browser-workspace";
import { getTerminalBrowserDeviceState } from "../device/emulation.js";
import { createTerminalBrowserDeviceState } from "@runweave/shared/terminal-browser-device";
import { DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE } from "@runweave/shared/terminal-browser-display-scale";
import {
  createTerminalBrowserGroupId,
  getTerminalBrowserKey,
  getTerminalBrowserWorkspaceKey,
  terminalBrowserEvents,
  terminalBrowserRuntime,
  type TerminalBrowserGroupRecord,
  type TerminalBrowserWindowWorkspace,
} from "../runtime.js";

export const TERMINAL_BROWSER_PLACEHOLDER_GROUP_NAME = "新工作组";
export const TERMINAL_BROWSER_MAX_GROUP_NAME_LENGTH = 40;

function getOrCreateWindowWorkspace(
  windowId: number,
  profileId: TerminalBrowserProfileId,
): TerminalBrowserWindowWorkspace {
  const key = getTerminalBrowserWorkspaceKey(windowId, profileId);
  const existing = terminalBrowserRuntime.workspaceByKey.get(key);
  if (existing) {
    return existing;
  }
  const workspace: TerminalBrowserWindowWorkspace = {
    profileId,
    revision: 0,
    groups: [],
  };
  terminalBrowserRuntime.workspaceByKey.set(key, workspace);
  return workspace;
}

export function normalizeTerminalBrowserGroupName(
  name: unknown,
): string | null {
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
      return (
        new URL(normalizedTitle).toString() ===
        new URL(normalizedUrl).toString()
      );
    } catch {
      return normalizedTitle === normalizedUrl;
    }
  })();
  if (normalizedTitle && normalizedTitle !== "about:blank" && !titleIsUrl) {
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
  profileId: TerminalBrowserProfileId,
): TerminalBrowserGroupRecord[] {
  return getOrCreateWindowWorkspace(windowId, profileId).groups;
}

export function getTerminalBrowserGroup(
  windowId: number,
  profileId: TerminalBrowserProfileId,
  groupId: string,
): TerminalBrowserGroupRecord | null {
  return (
    getOrCreateWindowWorkspace(windowId, profileId).groups.find(
      (group) => group.id === groupId,
    ) ?? null
  );
}

export function setTerminalBrowserGroupMetadata(
  windowId: number,
  profileId: TerminalBrowserProfileId,
  groupId: string,
  name: string,
  nameOrigin: TerminalBrowserGroupNameOrigin,
): void {
  const group = getTerminalBrowserGroup(windowId, profileId, groupId);
  const normalizedName = normalizeTerminalBrowserGroupName(name);
  if (!group || !normalizedName) {
    throw new Error("Invalid terminal browser group metadata");
  }
  group.name = normalizedName;
  group.nameOrigin = nameOrigin;
}

export function registerTerminalBrowserTab(
  windowId: number,
  profileId: TerminalBrowserProfileId,
  tabId: string,
  browserGroupId: string,
  openerTabId?: string,
): void {
  const workspace = getOrCreateWindowWorkspace(windowId, profileId);
  for (const group of workspace.groups) {
    group.tabIds = group.tabIds.filter((memberId) => memberId !== tabId);
  }
  let group = workspace.groups.find(
    (candidate) => candidate.id === browserGroupId,
  );
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
  workspace.groups = workspace.groups.filter(
    (candidate) => candidate.tabIds.length > 0,
  );
  assertTerminalBrowserWorkspaceIntegrity(windowId, profileId);
}

/**
 * Ensure an empty workspace has a selectable tab without allocating a
 * WebContents. Cold restore must stay metadata-only until the Profile route is
 * resolved, otherwise a persisted business URL can navigate outside Whistle.
 */
export function ensureTerminalBrowserDormantFallback(
  windowId: number,
  profileId: TerminalBrowserProfileId,
): string {
  const existingTabId = getOrderedTerminalBrowserTabIds(windowId, profileId)[0];
  if (existingTabId) {
    return existingTabId;
  }
  const tabId = `browser-tab-${randomUUID().slice(0, 8)}`;
  const browserGroupId = createTerminalBrowserGroupId();
  terminalBrowserRuntime.dormantTabs.set(
    getTerminalBrowserKey(windowId, profileId, tabId),
    {
      windowId,
      profileId,
      tabId,
      browserGroupId,
      url: "about:blank",
      title: "",
      lastActiveAt: Date.now(),
    },
  );
  registerTerminalBrowserTab(windowId, profileId, tabId, browserGroupId);
  terminalBrowserRuntime.attachedByWorkspaceKey.set(
    getTerminalBrowserWorkspaceKey(windowId, profileId),
    tabId,
  );
  return tabId;
}

export function removeTerminalBrowserTabFromWorkspace(
  windowId: number,
  profileId: TerminalBrowserProfileId,
  tabId: string,
): void {
  const workspace = getOrCreateWindowWorkspace(windowId, profileId);
  workspace.groups = workspace.groups
    .map((group) => ({
      ...group,
      tabIds: group.tabIds.filter((memberId) => memberId !== tabId),
    }))
    .filter((group) => group.tabIds.length > 0);
}

export function reorderTerminalBrowserGroupTabs(
  windowId: number,
  profileId: TerminalBrowserProfileId,
  groupId: string,
  orderedTabIds: string[],
): void {
  const group = getTerminalBrowserGroup(windowId, profileId, groupId);
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
  assertTerminalBrowserWorkspaceIntegrity(windowId, profileId);
}

export function renameTerminalBrowserGroup(
  windowId: number,
  profileId: TerminalBrowserProfileId,
  groupId: string,
  name: unknown,
): void {
  const group = getTerminalBrowserGroup(windowId, profileId, groupId);
  const normalizedName = normalizeTerminalBrowserGroupName(name);
  if (!group || !normalizedName) {
    throw new Error("Invalid terminal browser group name");
  }
  group.name = normalizedName;
  group.nameOrigin = "user";
}

export function maybeAutomaticallyNameTerminalBrowserGroup(
  windowId: number,
  profileId: TerminalBrowserProfileId,
  groupId: string,
  title: string,
  url: string,
): boolean {
  const group = getTerminalBrowserGroup(windowId, profileId, groupId);
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

export function getOrderedTerminalBrowserTabIds(
  windowId: number,
  profileId: TerminalBrowserProfileId,
): string[] {
  return getOrCreateWindowWorkspace(windowId, profileId).groups.flatMap(
    (group) => group.tabIds,
  );
}

export function getTerminalBrowserWorkspaceSnapshot(
  windowId: number,
  profileId: TerminalBrowserProfileId,
): TerminalBrowserWorkspaceSnapshot {
  const workspace = getOrCreateWindowWorkspace(windowId, profileId);
  const workspaceKey = getTerminalBrowserWorkspaceKey(windowId, profileId);
  const activeTabId =
    terminalBrowserRuntime.attachedByWorkspaceKey.get(workspaceKey) ?? "";
  const tabs = getOrderedTerminalBrowserTabIds(windowId, profileId).flatMap(
    (tabId) => {
      const entry = terminalBrowserRuntime.entries.get(
        getTerminalBrowserKey(windowId, profileId, tabId),
      );
      const webContents = entry?.view.webContents;
      if (!entry || !webContents || webContents.isDestroyed()) {
        const dormant = terminalBrowserRuntime.dormantTabs.get(
          getTerminalBrowserKey(windowId, profileId, tabId),
        );
        if (!dormant) {
          return [];
        }
        return [
          {
            profileId,
            tabId,
            browserGroupId: dormant.browserGroupId,
            url: dormant.url,
            title: dormant.title,
            canGoBack: false,
            canGoForward: false,
            loading: false,
            active: activeTabId === tabId,
            cdpProxyAttached: false,
            mcpActivityUntil: null,
            devtoolsOpen: false,
            deviceState: createTerminalBrowserDeviceState("desktop"),
            displayScale: DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE,
            minimumViewportWidth: null,
            faviconDataUrl: null,
            navigationError: null,
          },
        ];
      }
      const history = webContents.navigationHistory;
      const url = webContents.getURL() || entry.lastKnownUrl;
      return [
        {
          profileId,
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
          minimumViewportWidth: entry.minimumViewportWidth,
          faviconDataUrl: entry.faviconDataUrl,
          navigationError: entry.navigationError,
        },
      ];
    },
  );
  return {
    profileId,
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

export function nextTerminalBrowserRevision(
  windowId: number,
  profileId: TerminalBrowserProfileId,
): number {
  const workspace = getOrCreateWindowWorkspace(windowId, profileId);
  workspace.revision += 1;
  return workspace.revision;
}

export function sendTerminalBrowserWorkspaceChanged(
  win: BrowserWindow,
  profileId: TerminalBrowserProfileId,
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    return;
  }
  const revision = nextTerminalBrowserRevision(win.id, profileId);
  const workspace = getTerminalBrowserWorkspaceSnapshot(win.id, profileId);
  const event: TerminalBrowserStateChangedEvent = {
    kind: "workspace",
    revision,
    workspace,
  };
  win.webContents.send("terminal-browser:state-changed", event);
  terminalBrowserEvents.emit("workspace-changed", {
    windowId: win.id,
    profileId,
  });
}

export function clearTerminalBrowserWorkspaces(windowId: number): void {
  for (const key of terminalBrowserRuntime.workspaceByKey.keys()) {
    if (key.startsWith(`${windowId}:`)) {
      terminalBrowserRuntime.workspaceByKey.delete(key);
      terminalBrowserRuntime.attachedByWorkspaceKey.delete(key);
    }
  }
}

export function assertTerminalBrowserWorkspaceIntegrity(
  windowId: number,
  profileId: TerminalBrowserProfileId,
): void {
  const workspace = getOrCreateWindowWorkspace(windowId, profileId);
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
        getTerminalBrowserKey(windowId, profileId, tabId),
      );
      const dormant = terminalBrowserRuntime.dormantTabs.get(
        getTerminalBrowserKey(windowId, profileId, tabId),
      );
      if (
        (!entry || entry.browserGroupId !== group.id) &&
        (!dormant || dormant.browserGroupId !== group.id)
      ) {
        throw new Error("Terminal browser workspace membership mismatch");
      }
      tabIds.add(tabId);
    }
  }
  for (const [key, entry] of terminalBrowserRuntime.entries) {
    if (
      entry.windowId !== windowId ||
      entry.profileId !== profileId ||
      entry.view.webContents.isDestroyed()
    ) {
      continue;
    }
    const tabId = key.slice(`${windowId}:${profileId}:`.length);
    if (!tabIds.has(tabId)) {
      throw new Error("Live terminal browser tab missing from workspace");
    }
  }
  for (const [key, dormant] of terminalBrowserRuntime.dormantTabs) {
    if (dormant.windowId !== windowId || dormant.profileId !== profileId) {
      continue;
    }
    const tabId = key.slice(`${windowId}:${profileId}:`.length);
    if (!tabIds.has(tabId)) {
      throw new Error("Dormant terminal browser tab missing from workspace");
    }
  }
}
