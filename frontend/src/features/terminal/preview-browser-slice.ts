import {
  createTerminalBrowserDeviceState,
  type TerminalBrowserDeviceState,
} from "@runweave/shared/terminal-browser-device";
import { DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE } from "@runweave/shared/terminal-browser-display-scale";
import type { TerminalBrowserGroupSnapshot } from "@runweave/shared/terminal-browser-workspace";
import type { StoreApi } from "zustand";
import type {
  TerminalBrowserTabState,
  TerminalPreviewStore,
} from "./preview-store-types";

type SetTerminalPreviewStore = StoreApi<TerminalPreviewStore>["setState"];
type TerminalPreviewBrowserActions = Pick<
  TerminalPreviewStore,
  | "createBrowserTab"
  | "createBrowserGroup"
  | "applyBrowserWorkspace"
  | "closeBrowserTab"
  | "setActiveBrowserTab"
  | "reorderBrowserGroupTabs"
  | "updateBrowserTab"
>;

const DEFAULT_BROWSER_URL = "";
const DEFAULT_BROWSER_TAB_TITLE = "New Tab";
let browserTabSequence = 1;
let browserGroupSequence = 1;

function createBrowserTabState(
  browserGroupId: string,
  url = DEFAULT_BROWSER_URL,
): TerminalBrowserTabState {
  const id = `browser-tab-${browserTabSequence++}`;
  const browserUrl = normalizeBrowserTabUrl(url);
  return {
    id,
    browserGroupId,
    url: browserUrl,
    addressInput: browserUrl,
    title: labelBrowserUrl(browserUrl),
    loading: false,
    canGoBack: false,
    canGoForward: false,
    faviconDataUrl: null,
    navigationError: null,
    deviceState: createTerminalBrowserDeviceState("desktop"),
    displayScale: DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE,
  };
}

function createLocalBrowserGroup(): TerminalBrowserGroupSnapshot {
  return {
    id: `local-browser-group-${browserGroupSequence++}`,
    name: "新工作组",
    nameOrigin: "placeholder",
    tabIds: [],
  };
}

function insertAfter<T>(items: T[], index: number, item: T): T[] {
  const nextItems = [...items];
  nextItems.splice(index >= 0 ? index + 1 : nextItems.length, 0, item);
  return nextItems;
}

function labelBrowserUrl(url: string): string {
  if (!url || url === "about:blank") {
    return DEFAULT_BROWSER_TAB_TITLE;
  }
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      return `Local ${parsed.port || parsed.protocol.replace(":", "")}`;
    }
    return parsed.hostname || url;
  } catch {
    return url || DEFAULT_BROWSER_TAB_TITLE;
  }
}

function normalizeBrowserTabUrl(url: string): string {
  return url === "about:blank" ? "" : url;
}

function sameBrowserDeviceState(
  current: TerminalBrowserDeviceState,
  next: TerminalBrowserDeviceState,
): boolean {
  const currentViewport = current.viewport;
  const nextViewport = next.viewport;
  return (
    current.presetId === next.presetId &&
    current.label === next.label &&
    current.mobile === next.mobile &&
    (currentViewport === nextViewport ||
      (currentViewport !== null &&
        nextViewport !== null &&
        currentViewport.width === nextViewport.width &&
        currentViewport.height === nextViewport.height &&
        currentViewport.deviceScaleFactor === nextViewport.deviceScaleFactor))
  );
}

function hasBrowserTabChanges(
  tab: TerminalBrowserTabState,
  updates: Partial<TerminalBrowserTabState>,
): boolean {
  for (const key of Object.keys(updates) as Array<keyof TerminalBrowserTabState>) {
    if (key === "deviceState") {
      const nextDeviceState = updates.deviceState;
      if (
        nextDeviceState === undefined ||
        !sameBrowserDeviceState(tab.deviceState, nextDeviceState)
      ) {
        return true;
      }
      continue;
    }
    if (!Object.is(tab[key], updates[key])) {
      return true;
    }
  }
  return false;
}

const initialGroup = createLocalBrowserGroup();
const initialTab = createBrowserTabState(initialGroup.id);
initialGroup.tabIds.push(initialTab.id);

export function createInitialTerminalBrowserState(): TerminalPreviewStore["browser"] {
  return {
    revision: -1,
    groups: [initialGroup],
    tabs: [initialTab],
    activeTabId: initialTab.id,
  };
}

export function createTerminalPreviewBrowserActions(
  set: SetTerminalPreviewStore,
): TerminalPreviewBrowserActions {
  return {
    createBrowserTab: (url?: string) => {
      set((state) => {
        const activeTab = state.browser.tabs.find(
          (tab) => tab.id === state.browser.activeTabId,
        );
        const group =
          state.browser.groups.find((candidate) =>
            candidate.tabIds.includes(activeTab?.id ?? ""),
          ) ?? state.browser.groups[0];
        if (!group) {
          return state;
        }
        const nextTab = createBrowserTabState(group.id, url);
        const activeMemberIndex = group.tabIds.indexOf(activeTab?.id ?? "");
        const groups = state.browser.groups.map((candidate) =>
          candidate.id === group.id
            ? {
                ...candidate,
                tabIds: insertAfter(candidate.tabIds, activeMemberIndex, nextTab.id),
              }
            : candidate,
        );
        const globalIndex = state.browser.tabs.findIndex(
          (tab) => tab.id === activeTab?.id,
        );
        return {
          browser: {
            ...state.browser,
            groups,
            tabs: insertAfter(state.browser.tabs, globalIndex, nextTab),
            activeTabId: nextTab.id,
          },
        };
      });
    },
    createBrowserGroup: (url?: string) => {
      set((state) => {
        const group = createLocalBrowserGroup();
        const tab = createBrowserTabState(group.id, url);
        group.tabIds.push(tab.id);
        return {
          browser: {
            ...state.browser,
            groups: [...state.browser.groups, group],
            tabs: [...state.browser.tabs, tab],
            activeTabId: tab.id,
          },
        };
      });
    },
    applyBrowserWorkspace: (
      revision,
      groups,
      tabs,
      activeTabId,
      preserveAddressTabId,
      force,
    ) => {
      set((state) => {
        if (
          revision < state.browser.revision ||
          (!force && revision === state.browser.revision) ||
          tabs.length === 0
        ) {
          return state;
        }
        const currentAddress = preserveAddressTabId
          ? state.browser.tabs.find((tab) => tab.id === preserveAddressTabId)
              ?.addressInput
          : undefined;
        const nextTabs = tabs.map((tab) =>
          tab.id === preserveAddressTabId && currentAddress !== undefined
            ? { ...tab, addressInput: currentAddress }
            : tab,
        );
        return {
          browser: {
            revision,
            groups,
            tabs: nextTabs,
            activeTabId: nextTabs.some((tab) => tab.id === activeTabId)
              ? activeTabId
              : nextTabs[0]!.id,
          },
        };
      });
    },
    reorderBrowserGroupTabs: (groupId, fromIndex, toIndex) => {
      set((state) => {
        const group = state.browser.groups.find((candidate) => candidate.id === groupId);
        if (
          !group ||
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= group.tabIds.length ||
          toIndex >= group.tabIds.length ||
          fromIndex === toIndex
        ) {
          return state;
        }
        const tabIds = [...group.tabIds];
        const [moved] = tabIds.splice(fromIndex, 1);
        tabIds.splice(toIndex, 0, moved!);
        const groups = state.browser.groups.map((candidate) =>
          candidate.id === groupId ? { ...candidate, tabIds } : candidate,
        );
        const tabsById = new Map(state.browser.tabs.map((tab) => [tab.id, tab]));
        const tabs = groups.flatMap((candidate) =>
          candidate.tabIds.flatMap((tabId) => {
            const tab = tabsById.get(tabId);
            return tab ? [tab] : [];
          }),
        );
        return { browser: { ...state.browser, groups, tabs } };
      });
    },
    closeBrowserTab: (tabId) => {
      set((state) => {
        const closingIndex = state.browser.tabs.findIndex((tab) => tab.id === tabId);
        if (closingIndex < 0) {
          return state;
        }
        let groups = state.browser.groups
          .map((group) => ({
            ...group,
            tabIds: group.tabIds.filter((memberId) => memberId !== tabId),
          }))
          .filter((group) => group.tabIds.length > 0);
        let tabs = state.browser.tabs.filter((tab) => tab.id !== tabId);
        if (tabs.length === 0) {
          const group = createLocalBrowserGroup();
          const tab = createBrowserTabState(group.id);
          group.tabIds.push(tab.id);
          groups = [group];
          tabs = [tab];
        }
        const activeTabId =
          state.browser.activeTabId === tabId
            ? tabs[Math.min(closingIndex, tabs.length - 1)]!.id
            : state.browser.activeTabId;
        return { browser: { ...state.browser, groups, tabs, activeTabId } };
      });
    },
    setActiveBrowserTab: (tabId) => {
      set((state) =>
        state.browser.tabs.some((tab) => tab.id === tabId)
          ? { browser: { ...state.browser, activeTabId: tabId } }
          : state,
      );
    },
    updateBrowserTab: (tabId, updates, revision) => {
      set((state) => {
        if (revision !== undefined && revision <= state.browser.revision) {
          return state;
        }
        const index = state.browser.tabs.findIndex((tab) => tab.id === tabId);
        if (index < 0) {
          return state;
        }
        const tab = state.browser.tabs[index]!;
        if (!hasBrowserTabChanges(tab, updates) && revision === undefined) {
          return state;
        }
        const tabs = [...state.browser.tabs];
        tabs[index] = { ...tab, ...updates };
        return {
          browser: {
            ...state.browser,
            revision: revision ?? state.browser.revision,
            tabs,
          },
        };
      });
    },
  };
}
