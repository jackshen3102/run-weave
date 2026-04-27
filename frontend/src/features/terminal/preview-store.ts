import { create } from "zustand";
import type { StateCreator } from "zustand";
import type { TerminalPreviewChangeKind } from "@browser-viewer/shared";

export type TerminalPreviewMode = "file" | "changes";
export type TerminalMarkdownViewMode = "source" | "split" | "preview";
export type TerminalSvgViewMode = "preview" | "source";
export type TerminalChangesViewMode = "diff" | "preview";
export type TerminalSidecarTool = "preview" | "browser";

export interface TerminalBrowserTabState {
  id: string;
  url: string;
  addressInput: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
  cdpProxyAttached?: boolean;
  devtoolsOpen?: boolean;
}

export const DEFAULT_MARKDOWN_VIEW_MODE: TerminalMarkdownViewMode = "preview";

interface TerminalPreviewUiState {
  open: boolean;
  widthPx?: number;
  expanded: boolean;
  activeTool: TerminalSidecarTool;
}

export interface TerminalPreviewProjectState {
  mode: TerminalPreviewMode | null;
  path?: string;
  openFileQuery?: string;
  selectedFilePath?: string;
  selectedChangePath?: string;
  selectedChangeKind?: TerminalPreviewChangeKind;
  markdownViewMode?: TerminalMarkdownViewMode;
  markdownSplitSourceWidthPct?: number;
  svgViewMode?: TerminalSvgViewMode;
  changesViewMode?: TerminalChangesViewMode;
}

interface TerminalPreviewStore {
  ui: TerminalPreviewUiState;
  projects: Record<string, TerminalPreviewProjectState>;
  browser: {
    tabs: TerminalBrowserTabState[];
    activeTabId: string;
  };
  openPreview: (projectId: string, mode?: TerminalPreviewMode) => void;
  openBrowser: () => void;
  closePreview: () => void;
  setActiveTool: (tool: TerminalSidecarTool) => void;
  setWidth: (widthPx: number) => void;
  setExpanded: (expanded: boolean) => void;
  updateProjectPreview: (
    projectId: string,
    updates: Partial<TerminalPreviewProjectState>,
  ) => void;
  removeProjectPreview: (projectId: string) => void;
  createBrowserTab: (url?: string) => void;
  addProxyBrowserTab: (tabId: string, url: string, title: string) => void;
  closeBrowserTab: (tabId: string) => void;
  setActiveBrowserTab: (tabId: string) => void;
  updateBrowserTab: (
    tabId: string,
    updates: Partial<TerminalBrowserTabState>,
  ) => void;
}

const DEFAULT_PROJECT_STATE: TerminalPreviewProjectState = {
  mode: null,
};
const DEFAULT_BROWSER_URL = "http://127.0.0.1:5173";
let browserTabSequence = 1;

function createBrowserTabState(url = DEFAULT_BROWSER_URL): TerminalBrowserTabState {
  const id = `browser-tab-${browserTabSequence}`;
  browserTabSequence += 1;
  return {
    id,
    url,
    addressInput: url,
    title: labelBrowserUrl(url),
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
}

function labelBrowserUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost"
    ) {
      return `Local ${parsed.port || parsed.protocol.replace(":", "")}`;
    }
    return parsed.hostname || url;
  } catch {
    return url;
  }
}

const DEFAULT_BROWSER_TAB = createBrowserTabState();

const createTerminalPreviewStore: StateCreator<TerminalPreviewStore> = (set) => ({
  ui: { open: true, expanded: false, activeTool: "preview" },
  projects: {},
  browser: {
    tabs: [DEFAULT_BROWSER_TAB],
    activeTabId: DEFAULT_BROWSER_TAB.id,
  },
  openPreview: (projectId: string, mode?: TerminalPreviewMode) => {
    set((state: TerminalPreviewStore) => {
      const currentProject = state.projects[projectId] ?? DEFAULT_PROJECT_STATE;
      return {
        ui: { ...state.ui, open: true, activeTool: "preview" },
        projects: {
          ...state.projects,
          [projectId]: {
            ...currentProject,
            mode: mode ?? currentProject.mode,
          },
        },
      };
    });
  },
  openBrowser: () => {
    set((state: TerminalPreviewStore) => ({
      ui: { ...state.ui, open: true, activeTool: "browser" },
    }));
  },
  closePreview: () => {
    set((state: TerminalPreviewStore) => ({
      ui: { ...state.ui, open: false, expanded: false },
    }));
  },
  setActiveTool: (tool: TerminalSidecarTool) => {
    set((state: TerminalPreviewStore) => ({
      ui: { ...state.ui, activeTool: tool },
    }));
  },
  setWidth: (widthPx: number) => {
    set((state: TerminalPreviewStore) => ({
      ui: { ...state.ui, widthPx },
    }));
  },
  setExpanded: (expanded: boolean) => {
    set((state: TerminalPreviewStore) => ({
      ui: { ...state.ui, expanded },
    }));
  },
  updateProjectPreview: (
    projectId: string,
    updates: Partial<TerminalPreviewProjectState>,
  ) => {
    set((state: TerminalPreviewStore) => ({
      projects: {
        ...state.projects,
        [projectId]: {
          ...(state.projects[projectId] ?? DEFAULT_PROJECT_STATE),
          ...updates,
        },
      },
    }));
  },
  removeProjectPreview: (projectId: string) => {
    set((state: TerminalPreviewStore) => {
      const nextProjects = { ...state.projects };
      delete nextProjects[projectId];
      return { projects: nextProjects };
    });
  },
  createBrowserTab: (url?: string) => {
    set((state: TerminalPreviewStore) => {
      const nextTab = createBrowserTabState(url);
      return {
        browser: {
          tabs: [...state.browser.tabs, nextTab],
          activeTabId: nextTab.id,
        },
      };
    });
  },
  addProxyBrowserTab: (tabId: string, url: string, title: string) => {
    set((state: TerminalPreviewStore) => {
      if (state.browser.tabs.some((tab) => tab.id === tabId)) {
        return state;
      }
      const nextTab: TerminalBrowserTabState = {
        id: tabId,
        url,
        addressInput: url,
        title: title || labelBrowserUrl(url),
        loading: false,
        canGoBack: false,
        canGoForward: false,
      };
      return {
        browser: {
          tabs: [...state.browser.tabs, nextTab],
          activeTabId: nextTab.id,
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
      const tabs = remainingTabs.length > 0 ? remainingTabs : [createBrowserTabState()];
      const closingActiveTab = state.browser.activeTabId === tabId;
      const nextActiveTab = closingActiveTab
        ? (tabs[Math.min(closingIndex, tabs.length - 1)] as TerminalBrowserTabState)
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
    set((state: TerminalPreviewStore) => ({
      browser: {
        ...state.browser,
        tabs: state.browser.tabs.map((tab) =>
          tab.id === tabId ? { ...tab, ...updates } : tab,
        ),
      },
    }));
  },
});

export const useTerminalPreviewStore = create<TerminalPreviewStore>()(
  createTerminalPreviewStore,
);
