import { create } from "zustand";
import type { StateCreator } from "zustand";
import {
  createTerminalBrowserDeviceState,
  type TerminalBrowserDeviceState,
  type TerminalPreviewChangeKind,
} from "@runweave/shared";

export type TerminalPreviewMode = "file" | "changes" | "explorer";
export type TerminalMarkdownViewMode = "source" | "split" | "preview";
export type TerminalSvgViewMode = "preview" | "source";
export type TerminalChangesViewMode = "diff" | "preview";
export type TerminalSidecarTool = "preview" | "browser" | "agent-team";

export const DEFAULT_TERMINAL_SIDECAR_WIDTH = "clamp(320px, 60vw, 60vw)";
const TERMINAL_SIDECAR_WIDTH_STORAGE_KEY =
  "runweave.terminal.sidecar.width.v1";

export interface TerminalBrowserTabState {
  id: string;
  browserGroupId?: string;
  url: string;
  addressInput: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
  cdpProxyAttached?: boolean;
  mcpActivityUntil?: number | null;
  devtoolsOpen?: boolean;
  deviceState: TerminalBrowserDeviceState;
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
  openAgentTeam: () => void;
  closePreview: () => void;
  setActiveTool: (tool: TerminalSidecarTool) => void;
  setWidth: (widthPx: number) => void;
  setExpanded: (expanded: boolean) => void;
  updateProjectPreview: (
    projectId: string,
    updates: Partial<TerminalPreviewProjectState>,
  ) => void;
  setProjectPreviewMode: (
    projectId: string,
    mode: TerminalPreviewMode,
  ) => void;
  setOpenFileQuery: (projectId: string, query: string) => void;
  openFile: (
    projectId: string,
    filePath: string,
    mode?: Extract<TerminalPreviewMode, "file" | "explorer">,
  ) => void;
  selectChange: (
    projectId: string,
    filePath: string,
    kind: TerminalPreviewChangeKind,
  ) => void;
  clearSelectedChange: (projectId: string) => void;
  setMarkdownViewMode: (
    projectId: string,
    mode: TerminalMarkdownViewMode,
  ) => void;
  setMarkdownSplitSourceWidthPct: (projectId: string, widthPct: number) => void;
  setSvgViewMode: (projectId: string, mode: TerminalSvgViewMode) => void;
  setChangesViewMode: (projectId: string, mode: TerminalChangesViewMode) => void;
  removeProjectPreview: (projectId: string) => void;
  createBrowserTab: (url?: string) => void;
  addProxyBrowserTab: (
    tabId: string,
    browserGroupId: string | undefined,
    url: string,
    title: string,
  ) => void;
  replaceBrowserTabs: (
    tabs: TerminalBrowserTabState[],
    activeTabId?: string,
  ) => void;
  closeBrowserTab: (tabId: string) => void;
  setActiveBrowserTab: (tabId: string) => void;
  reorderBrowserTabs: (fromIndex: number, toIndex: number) => void;
  updateBrowserTab: (
    tabId: string,
    updates: Partial<TerminalBrowserTabState>,
  ) => void;
}

const DEFAULT_PROJECT_STATE: TerminalPreviewProjectState = {
  mode: null,
};
const DEFAULT_BROWSER_URL = "";
const DEFAULT_BROWSER_TAB_TITLE = "New Tab";
let browserTabSequence = 1;

function getMaxSidecarWidth(): number | null {
  if (typeof window === "undefined") {
    return null;
  }
  return Math.round(window.innerWidth * 0.6);
}

function normalizeSidecarWidth(widthPx: number): number | undefined {
  if (!Number.isFinite(widthPx) || widthPx <= 0) {
    return undefined;
  }
  const maxWidth = getMaxSidecarWidth();
  if (maxWidth === null) {
    return Math.round(widthPx);
  }
  return Math.min(maxWidth, Math.max(320, Math.round(widthPx)));
}

function readStoredSidecarWidth(): number | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  try {
    const rawWidth = window.localStorage.getItem(
      TERMINAL_SIDECAR_WIDTH_STORAGE_KEY,
    );
    if (!rawWidth) {
      return undefined;
    }
    return normalizeSidecarWidth(Number(rawWidth));
  } catch {
    return undefined;
  }
}

function persistSidecarWidth(widthPx: number): void {
  if (typeof window === "undefined") {
    return;
  }
  const normalizedWidth = normalizeSidecarWidth(widthPx);
  if (!normalizedWidth) {
    return;
  }
  try {
    window.localStorage.setItem(
      TERMINAL_SIDECAR_WIDTH_STORAGE_KEY,
      String(normalizedWidth),
    );
  } catch {
    // Ignore storage failures; the in-memory resize still applies.
  }
}

function createBrowserTabState(url = DEFAULT_BROWSER_URL): TerminalBrowserTabState {
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

function labelBrowserUrl(url: string): string {
  if (!url || url === "about:blank") {
    return DEFAULT_BROWSER_TAB_TITLE;
  }
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
    return url || DEFAULT_BROWSER_TAB_TITLE;
  }
}

function normalizeBrowserTabUrl(url: string): string {
  return url === "about:blank" ? "" : url;
}

const DEFAULT_BROWSER_TAB = createBrowserTabState();

const createTerminalPreviewStore: StateCreator<TerminalPreviewStore> = (set) => ({
  ui: {
    open: true,
    widthPx: readStoredSidecarWidth(),
    expanded: false,
    activeTool: "preview",
  },
  projects: {},
  browser: {
    tabs: [DEFAULT_BROWSER_TAB],
    activeTabId: DEFAULT_BROWSER_TAB.id,
  },
  openPreview: (projectId: string, mode?: TerminalPreviewMode) => {
    set((state: TerminalPreviewStore) => {
      const currentProject = state.projects[projectId] ?? DEFAULT_PROJECT_STATE;
      const nextMode = mode ?? currentProject.mode ?? "changes";
      return {
        ui: { ...state.ui, open: true, activeTool: "preview" },
        projects: {
          ...state.projects,
          [projectId]: {
            ...currentProject,
            mode: nextMode,
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
  openAgentTeam: () => {
    set((state: TerminalPreviewStore) => ({
      ui: { ...state.ui, open: true, activeTool: "agent-team" },
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
    persistSidecarWidth(widthPx);
    set((state: TerminalPreviewStore) => ({
      ui: { ...state.ui, widthPx: normalizeSidecarWidth(widthPx) ?? widthPx },
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
  setProjectPreviewMode: (projectId: string, mode: TerminalPreviewMode) => {
    set((state: TerminalPreviewStore) => ({
      projects: {
        ...state.projects,
        [projectId]: {
          ...(state.projects[projectId] ?? DEFAULT_PROJECT_STATE),
          mode,
        },
      },
    }));
  },
  setOpenFileQuery: (projectId: string, query: string) => {
    set((state: TerminalPreviewStore) => ({
      projects: {
        ...state.projects,
        [projectId]: {
          ...(state.projects[projectId] ?? DEFAULT_PROJECT_STATE),
          mode: "file",
          openFileQuery: query,
          selectedFilePath: undefined,
        },
      },
    }));
  },
  openFile: (
    projectId: string,
    filePath: string,
    mode: Extract<TerminalPreviewMode, "file" | "explorer"> = "file",
  ) => {
    set((state: TerminalPreviewStore) => ({
      projects: {
        ...state.projects,
        [projectId]: {
          ...(state.projects[projectId] ?? DEFAULT_PROJECT_STATE),
          mode,
          selectedFilePath: filePath,
          path: filePath,
        },
      },
    }));
  },
  selectChange: (
    projectId: string,
    filePath: string,
    kind: TerminalPreviewChangeKind,
  ) => {
    set((state: TerminalPreviewStore) => ({
      projects: {
        ...state.projects,
        [projectId]: {
          ...(state.projects[projectId] ?? DEFAULT_PROJECT_STATE),
          mode: "changes",
          selectedChangePath: filePath,
          selectedChangeKind: kind,
        },
      },
    }));
  },
  clearSelectedChange: (projectId: string) => {
    set((state: TerminalPreviewStore) => ({
      projects: {
        ...state.projects,
        [projectId]: {
          ...(state.projects[projectId] ?? DEFAULT_PROJECT_STATE),
          selectedChangePath: undefined,
          selectedChangeKind: undefined,
        },
      },
    }));
  },
  setMarkdownViewMode: (
    projectId: string,
    markdownViewMode: TerminalMarkdownViewMode,
  ) => {
    set((state: TerminalPreviewStore) => ({
      projects: {
        ...state.projects,
        [projectId]: {
          ...(state.projects[projectId] ?? DEFAULT_PROJECT_STATE),
          markdownViewMode,
        },
      },
    }));
  },
  setMarkdownSplitSourceWidthPct: (projectId: string, widthPct: number) => {
    set((state: TerminalPreviewStore) => ({
      projects: {
        ...state.projects,
        [projectId]: {
          ...(state.projects[projectId] ?? DEFAULT_PROJECT_STATE),
          markdownSplitSourceWidthPct: widthPct,
        },
      },
    }));
  },
  setSvgViewMode: (projectId: string, svgViewMode: TerminalSvgViewMode) => {
    set((state: TerminalPreviewStore) => ({
      projects: {
        ...state.projects,
        [projectId]: {
          ...(state.projects[projectId] ?? DEFAULT_PROJECT_STATE),
          svgViewMode,
        },
      },
    }));
  },
  setChangesViewMode: (
    projectId: string,
    changesViewMode: TerminalChangesViewMode,
  ) => {
    set((state: TerminalPreviewStore) => ({
      projects: {
        ...state.projects,
        [projectId]: {
          ...(state.projects[projectId] ?? DEFAULT_PROJECT_STATE),
          changesViewMode,
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
      const nextTab = createUniqueBrowserTabState(state.browser.tabs, url);
      return {
        browser: {
          tabs: [...state.browser.tabs, nextTab],
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
          tabs: [...state.browser.tabs, nextTab],
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
