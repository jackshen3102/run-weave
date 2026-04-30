export const TERMINAL_BROWSER_MAX_RESTORED_TABS = 5;

export interface TerminalBrowserPersistedTabRecord {
  id: string;
  url: string;
  title: string;
  lastActiveAt: number;
}

export interface TerminalBrowserPersistedState {
  version: 1;
  activeTabId: string | null;
  tabs: TerminalBrowserPersistedTabRecord[];
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

export function selectTerminalBrowserTabsForRestore(
  tabs: TerminalBrowserPersistedTabRecord[],
  activeTabId: string | null,
  limit = TERMINAL_BROWSER_MAX_RESTORED_TABS,
): TerminalBrowserPersistedTabRecord[] {
  const nextTabs = [...tabs];

  while (nextTabs.length > limit) {
    let dropIndex = -1;
    let oldestLastActiveAt = Number.POSITIVE_INFINITY;

    for (let index = 0; index < nextTabs.length; index += 1) {
      const tab = nextTabs[index];
      if (!tab || tab.id === activeTabId) {
        continue;
      }
      if (tab.lastActiveAt < oldestLastActiveAt) {
        oldestLastActiveAt = tab.lastActiveAt;
        dropIndex = index;
      }
    }

    if (dropIndex === -1) {
      dropIndex = 0;
    }

    nextTabs.splice(dropIndex, 1);
  }

  return nextTabs;
}

export function normalizeTerminalBrowserPersistedState(
  value: unknown,
): TerminalBrowserPersistedState {
  if (!value || typeof value !== "object") {
    return { version: 1, activeTabId: null, tabs: [] };
  }

  const candidate = value as Record<string, unknown>;
  const rawTabs = Array.isArray(candidate.tabs) ? candidate.tabs : [];
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
    });
  }

  const activeTabId =
    typeof candidate.activeTabId === "string" &&
    seenTabIds.has(candidate.activeTabId)
      ? candidate.activeTabId
      : (tabs[0]?.id ?? null);

  return {
    version: 1,
    activeTabId:
      activeTabId && tabs.some((tab) => tab.id === activeTabId)
        ? activeTabId
        : (tabs[0]?.id ?? null),
    tabs,
  };
}
