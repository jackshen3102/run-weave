import type {
  TerminalBrowserGroupNameOrigin,
  TerminalBrowserGroupSnapshot,
} from "@runweave/shared/terminal-browser-workspace";
import {
  TERMINAL_BROWSER_PROFILE_IDS,
  type TerminalBrowserProfileId,
} from "@runweave/shared/terminal-browser-profile";

export const TERMINAL_BROWSER_MAX_RESTORED_TABS = 5;
const PLACEHOLDER_GROUP_NAME = "新工作组";
const MAX_GROUP_NAME_LENGTH = 40;

export interface TerminalBrowserPersistedTabRecord {
  id: string;
  url: string;
  title: string;
  lastActiveAt: number;
  browserGroupId: string;
}

export interface TerminalBrowserPersistedProfileState {
  activeTabId: string | null;
  groups: TerminalBrowserGroupSnapshot[];
  tabs: TerminalBrowserPersistedTabRecord[];
}

export interface TerminalBrowserPersistedState {
  version: 3;
  profiles: Record<
    TerminalBrowserProfileId,
    TerminalBrowserPersistedProfileState
  >;
}

export function createEmptyTerminalBrowserPersistedState(): TerminalBrowserPersistedState {
  return {
    version: 3,
    profiles: {
      "profile-1": createEmptyTerminalBrowserPersistedProfileState(),
      "profile-2": createEmptyTerminalBrowserPersistedProfileState(),
      "profile-3": createEmptyTerminalBrowserPersistedProfileState(),
    },
  };
}

export function createEmptyTerminalBrowserPersistedProfileState(): TerminalBrowserPersistedProfileState {
  return { activeTabId: null, groups: [], tabs: [] };
}

export function normalizeTerminalBrowserUrlForStorage(
  url: unknown,
): string | null {
  if (typeof url !== "string") {
    return null;
  }
  if (url === "about:blank") {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function truncateGroupName(name: string): string {
  return Array.from(name).slice(0, MAX_GROUP_NAME_LENGTH).join("");
}

function automaticGroupName(tab: TerminalBrowserPersistedTabRecord): {
  name: string;
  nameOrigin: TerminalBrowserGroupNameOrigin;
} {
  const title = tab.title.trim();
  const titleLooksLikeUrl = (() => {
    try {
      return new URL(title).toString() === new URL(tab.url).toString();
    } catch {
      return title === tab.url;
    }
  })();
  if (title && title !== "about:blank" && !titleLooksLikeUrl) {
    return { name: truncateGroupName(title), nameOrigin: "automatic" };
  }
  try {
    const hostname = new URL(tab.url).hostname;
    if (hostname) {
      return { name: truncateGroupName(hostname), nameOrigin: "automatic" };
    }
  } catch {
    // about:blank has no hostname.
  }
  return { name: PLACEHOLDER_GROUP_NAME, nameOrigin: "placeholder" };
}

function buildGroupsFromFlatTabs(
  tabs: TerminalBrowserPersistedTabRecord[],
): TerminalBrowserGroupSnapshot[] {
  const groups: TerminalBrowserGroupSnapshot[] = [];
  for (const tab of tabs) {
    let group = groups.find((candidate) => candidate.id === tab.browserGroupId);
    if (!group) {
      const automaticName = automaticGroupName(tab);
      group = {
        id: tab.browserGroupId,
        ...automaticName,
        tabIds: [],
      };
      groups.push(group);
    }
    group.tabIds.push(tab.id);
  }
  return groups;
}

function normalizeFlatTabs(
  value: unknown,
): TerminalBrowserPersistedTabRecord[] {
  const rawTabs = Array.isArray(value) ? value : [];
  const seenTabIds = new Set<string>();
  const tabs: TerminalBrowserPersistedTabRecord[] = [];
  for (const rawTab of rawTabs) {
    if (!rawTab || typeof rawTab !== "object") {
      continue;
    }
    const tab = rawTab as Record<string, unknown>;
    const id = typeof tab.id === "string" ? tab.id.trim() : "";
    const url = normalizeTerminalBrowserUrlForStorage(tab.url);
    if (!id || seenTabIds.has(id) || !url) {
      continue;
    }
    seenTabIds.add(id);
    tabs.push({
      id,
      url,
      title: typeof tab.title === "string" ? tab.title : "",
      lastActiveAt:
        typeof tab.lastActiveAt === "number" &&
        Number.isFinite(tab.lastActiveAt)
          ? tab.lastActiveAt
          : 0,
      browserGroupId:
        typeof tab.browserGroupId === "string" && tab.browserGroupId.trim()
          ? tab.browserGroupId.trim()
          : `browser-group-${id}`,
    });
  }
  return tabs;
}

function normalizeV2Groups(
  value: unknown,
  tabs: TerminalBrowserPersistedTabRecord[],
): TerminalBrowserGroupSnapshot[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  const seenGroupIds = new Set<string>();
  const seenTabIds = new Set<string>();
  const groups: TerminalBrowserGroupSnapshot[] = [];
  for (const rawGroup of value) {
    if (!rawGroup || typeof rawGroup !== "object") {
      return null;
    }
    const group = rawGroup as Record<string, unknown>;
    const id = typeof group.id === "string" ? group.id.trim() : "";
    const name = typeof group.name === "string" ? group.name.trim() : "";
    const nameLength = Array.from(name).length;
    const nameOrigin = group.nameOrigin;
    const tabIds = Array.isArray(group.tabIds)
      ? group.tabIds.filter(
          (tabId): tabId is string => typeof tabId === "string",
        )
      : [];
    if (
      !id ||
      seenGroupIds.has(id) ||
      !name ||
      nameLength > MAX_GROUP_NAME_LENGTH ||
      !["placeholder", "automatic", "user"].includes(String(nameOrigin)) ||
      tabIds.length === 0 ||
      tabIds.length !== (group.tabIds as unknown[] | undefined)?.length
    ) {
      return null;
    }
    for (const tabId of tabIds) {
      const tab = tabsById.get(tabId);
      if (!tab || seenTabIds.has(tabId) || tab.browserGroupId !== id) {
        return null;
      }
      seenTabIds.add(tabId);
    }
    seenGroupIds.add(id);
    groups.push({
      id,
      name,
      nameOrigin: nameOrigin as TerminalBrowserGroupNameOrigin,
      tabIds: [...tabIds],
    });
  }
  return seenTabIds.size === tabs.length ? groups : null;
}

export function selectTerminalBrowserStateForRestore(
  state: TerminalBrowserPersistedProfileState,
  limit = TERMINAL_BROWSER_MAX_RESTORED_TABS,
): TerminalBrowserPersistedProfileState {
  const orderedTabs = state.groups.flatMap((group) =>
    group.tabIds.flatMap((tabId) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      return tab ? [tab] : [];
    }),
  );
  const selectedTabs = [...orderedTabs];
  while (selectedTabs.length > limit) {
    let dropIndex = -1;
    let oldestLastActiveAt = Number.POSITIVE_INFINITY;
    for (let index = 0; index < selectedTabs.length; index += 1) {
      const tab = selectedTabs[index];
      if (!tab || tab.id === state.activeTabId) {
        continue;
      }
      if (tab.lastActiveAt < oldestLastActiveAt) {
        oldestLastActiveAt = tab.lastActiveAt;
        dropIndex = index;
      }
    }
    selectedTabs.splice(dropIndex === -1 ? 0 : dropIndex, 1);
  }
  const selectedIds = new Set(selectedTabs.map((tab) => tab.id));
  const groups = state.groups.flatMap((group) => {
    const tabIds = group.tabIds.filter((tabId) => selectedIds.has(tabId));
    return tabIds.length > 0 ? [{ ...group, tabIds }] : [];
  });
  const tabsById = new Map(selectedTabs.map((tab) => [tab.id, tab]));
  const tabs = groups.flatMap((group) =>
    group.tabIds.flatMap((tabId) => {
      const tab = tabsById.get(tabId);
      return tab ? [tab] : [];
    }),
  );
  const activeTabId =
    state.activeTabId && selectedIds.has(state.activeTabId)
      ? state.activeTabId
      : (tabs[0]?.id ?? null);
  return { activeTabId, groups, tabs };
}

function normalizeTerminalBrowserPersistedProfileState(
  value: unknown,
  version: unknown,
): TerminalBrowserPersistedProfileState {
  if (!value || typeof value !== "object") {
    return createEmptyTerminalBrowserPersistedProfileState();
  }
  const candidate = value as Record<string, unknown>;
  const tabs = normalizeFlatTabs(candidate.tabs);
  const groups =
    version === 2 || version === 3
      ? (normalizeV2Groups(candidate.groups, tabs) ??
        buildGroupsFromFlatTabs(tabs))
      : buildGroupsFromFlatTabs(tabs);
  const activeTabId =
    typeof candidate.activeTabId === "string" &&
    tabs.some((tab) => tab.id === candidate.activeTabId)
      ? candidate.activeTabId
      : (tabs[0]?.id ?? null);
  return { activeTabId, groups, tabs };
}

export function normalizeTerminalBrowserPersistedState(
  value: unknown,
): TerminalBrowserPersistedState {
  const empty = createEmptyTerminalBrowserPersistedState();
  if (!value || typeof value !== "object") {
    return empty;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version === 3 &&
    candidate.profiles &&
    typeof candidate.profiles === "object" &&
    !Array.isArray(candidate.profiles)
  ) {
    const rawProfiles = candidate.profiles as Record<string, unknown>;
    for (const profileId of TERMINAL_BROWSER_PROFILE_IDS) {
      empty.profiles[profileId] = normalizeTerminalBrowserPersistedProfileState(
        rawProfiles[profileId],
        3,
      );
    }
    return empty;
  }

  // v1/v2 used a single Browser Session. Preserve that state in Profile 1;
  // the other two profiles intentionally start empty.
  empty.profiles["profile-1"] = normalizeTerminalBrowserPersistedProfileState(
    candidate,
    candidate.version,
  );
  return empty;
}
