import {
  createTerminalBrowserDeviceState,
  type TerminalBrowserDeviceState,
} from "@runweave/shared/terminal-browser-device";
import type { StoreApi } from "zustand";
import type {
  TerminalBrowserTabState,
  TerminalPreviewStore,
} from "./preview-store-types";

type SetTerminalPreviewStore = StoreApi<TerminalPreviewStore>["setState"];
type TerminalPreviewBrowserActions = Pick<
  TerminalPreviewStore,
  | "createBrowserTab"
  | "addProxyBrowserTab"
  | "replaceBrowserTabs"
  | "closeBrowserTab"
  | "setActiveBrowserTab"
  | "reorderBrowserTabs"
  | "updateBrowserTab"
>;

const DEFAULT_BROWSER_URL = "";
const DEFAULT_BROWSER_TAB_TITLE = "New Tab";
let browserTabSequence = 1;

function createBrowserTabState(
  url = DEFAULT_BROWSER_URL,
): TerminalBrowserTabState {
  const id = `browser-tab-${browserTabSequence}`;
  browserTabSequence += 1;
  const browserUrl = normalizeBrowserTabUrl(url);
  return {
    id,
    url: browserUrl,
    addressInput: browserUrl,
    title: labelBrowserUrl(browserUrl),
    loading: false,
    canGoBack: false,
    canGoForward: false,
    deviceState: createTerminalBrowserDeviceState("desktop"),
  };
}

function createUniqueBrowserTabState(
  existingTabs: TerminalBrowserTabState[],
  url?: string,
): TerminalBrowserTabState {
  let nextTab = createBrowserTabState(url);
  while (existingTabs.some((tab) => tab.id === nextTab.id)) {
    nextTab = createBrowserTabState(url);
  }
  return nextTab;
}

// Insert a new tab immediately to the right of the anchor tab, matching browser
// behavior where an opened tab appears next to the one that spawned it. Falls
// back to appending at the end when the anchor is missing (e.g. agent-created
// tabs with no DOM opener).
function insertTabAfter(
  tabs: TerminalBrowserTabState[],
  anchorId: string | undefined,
  newTab: TerminalBrowserTabState,
): TerminalBrowserTabState[] {
  const anchorIndex = anchorId
    ? tabs.findIndex((tab) => tab.id === anchorId)
    : -1;
  if (anchorIndex === -1) {
    return [...tabs, newTab];
  }
  const nextTabs = [...tabs];
  nextTabs.splice(anchorIndex + 1, 0, newTab);
  return nextTabs;
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
  const sameViewport =
    currentViewport === nextViewport ||
    (currentViewport !== null &&
      nextViewport !== null &&
      currentViewport.width === nextViewport.width &&
      currentViewport.height === nextViewport.height &&
      currentViewport.deviceScaleFactor === nextViewport.deviceScaleFactor);
  return (
    current.presetId === next.presetId &&
    current.label === next.label &&
    current.mobile === next.mobile &&
    sameViewport
  );
}

function hasBrowserTabChanges(
  tab: TerminalBrowserTabState,
  updates: Partial<TerminalBrowserTabState>,
): boolean {
  for (const key of Object.keys(updates) as Array<
    keyof TerminalBrowserTabState
  >) {
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
    const nextValue = updates[key];
    if (!Object.is(tab[key], nextValue)) {
      return true;
    }
  }
  return false;
}

const DEFAULT_BROWSER_TAB = createBrowserTabState();

export function createInitialTerminalBrowserState(): TerminalPreviewStore["browser"] {
  return {
    tabs: [DEFAULT_BROWSER_TAB],
    activeTabId: DEFAULT_BROWSER_TAB.id,
  };
}

export function createTerminalPreviewBrowserActions(
  set: SetTerminalPreviewStore,
): TerminalPreviewBrowserActions {
  return {
    createBrowserTab: (url?: string) => {
      set((state: TerminalPreviewStore) => {
        const nextTab = createUniqueBrowserTabState(state.browser.tabs, url);
        return {
          browser: {
            tabs: insertTabAfter(
              state.browser.tabs,
              state.browser.activeTabId,
              nextTab,
            ),
            activeTabId: nextTab.id,
          },
        };
      });
    },
    addProxyBrowserTab: (
      tabId: string,
      browserGroupId: string | undefined,
      url: string,
      title: string,
      openerTabId?: string,
    ) => {
      set((state: TerminalPreviewStore) => {
        if (state.browser.tabs.some((tab) => tab.id === tabId)) {
          return {
            browser: {
              ...state.browser,
              tabs: state.browser.tabs.map((tab) =>
                tab.id === tabId && browserGroupId
                  ? { ...tab, browserGroupId }
                  : tab,
              ),
            },
          };
        }
        const browserUrl = normalizeBrowserTabUrl(url);
        const browserTitle = title.trim() === "about:blank" ? "" : title;
        const nextTab: TerminalBrowserTabState = {
          id: tabId,
          browserGroupId,
          url: browserUrl,
          addressInput: browserUrl,
          title: browserTitle || labelBrowserUrl(browserUrl),
          loading: false,
          canGoBack: false,
          canGoForward: false,
          deviceState: createTerminalBrowserDeviceState("desktop"),
        };
        return {
          browser: {
            tabs: insertTabAfter(state.browser.tabs, openerTabId, nextTab),
            activeTabId: nextTab.id,
          },
        };
      });
    },
    replaceBrowserTabs: (
      tabs: TerminalBrowserTabState[],
      activeTabId?: string,
    ) => {
      set((state: TerminalPreviewStore) => {
        if (tabs.length === 0) {
          return state;
        }
        const nextActiveTab = activeTabId
          ? tabs.find((tab) => tab.id === activeTabId)
          : undefined;
        return {
          browser: {
            tabs,
            activeTabId: nextActiveTab?.id ?? tabs[0]!.id,
          },
        };
      });
    },
    reorderBrowserTabs: (fromIndex: number, toIndex: number) => {
      set((state: TerminalPreviewStore) => {
        const tabs = [...state.browser.tabs];
        if (
          fromIndex < 0 ||
          fromIndex >= tabs.length ||
          toIndex < 0 ||
          toIndex >= tabs.length ||
          fromIndex === toIndex
        ) {
          return state;
        }
        const [moved] = tabs.splice(fromIndex, 1);
        tabs.splice(toIndex, 0, moved!);
        return {
          browser: {
            ...state.browser,
            tabs,
          },
        };
      });
    },
    closeBrowserTab: (tabId: string) => {
      set((state: TerminalPreviewStore) => {
        const currentTabs = state.browser.tabs;
        const closingIndex = currentTabs.findIndex((tab) => tab.id === tabId);
        if (closingIndex === -1) {
          return state;
        }
        const remainingTabs = currentTabs.filter((tab) => tab.id !== tabId);
        const tabs =
          remainingTabs.length > 0
            ? remainingTabs
            : [createUniqueBrowserTabState(currentTabs)];
        const closingActiveTab = state.browser.activeTabId === tabId;
        const nextActiveTab = closingActiveTab
          ? (tabs[
              Math.min(closingIndex, tabs.length - 1)
            ] as TerminalBrowserTabState)
          : currentTabs.find((tab) => tab.id === state.browser.activeTabId);
        return {
          browser: {
            tabs,
            activeTabId: nextActiveTab?.id ?? tabs[0]!.id,
          },
        };
      });
    },
    setActiveBrowserTab: (tabId: string) => {
      set((state: TerminalPreviewStore) => {
        if (!state.browser.tabs.some((tab) => tab.id === tabId)) {
          return state;
        }
        return {
          browser: {
            ...state.browser,
            activeTabId: tabId,
          },
        };
      });
    },
    updateBrowserTab: (
      tabId: string,
      updates: Partial<TerminalBrowserTabState>,
    ) => {
      set((state: TerminalPreviewStore) => {
        let changed = false;
        const tabs = state.browser.tabs.map((tab) => {
          if (tab.id !== tabId) {
            return tab;
          }
          if (!hasBrowserTabChanges(tab, updates)) {
            return tab;
          }
          changed = true;
          return { ...tab, ...updates };
        });
        if (!changed) {
          return state;
        }
        return {
          browser: {
            ...state.browser,
            tabs,
          },
        };
      });
    },
  };
}
