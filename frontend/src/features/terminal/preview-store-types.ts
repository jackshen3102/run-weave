import type { TerminalBrowserDeviceState } from "@runweave/shared/terminal-browser-device";
import type { TerminalPreviewChangeKind } from "@runweave/shared/terminal/preview";

export type TerminalPreviewMode = "file" | "changes" | "explorer";
export type TerminalMarkdownViewMode = "source" | "split" | "preview";
export type TerminalSvgViewMode = "preview" | "source";
export type TerminalChangesViewMode = "diff" | "preview";
export type TerminalSidecarTool = "preview" | "browser" | "agent-team";

export const DEFAULT_TERMINAL_SIDECAR_WIDTH = "clamp(320px, 60vw, 60vw)";

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

export interface TerminalPreviewUiState {
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

export interface TerminalPreviewStore {
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
  setProjectPreviewMode: (projectId: string, mode: TerminalPreviewMode) => void;
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
  setChangesViewMode: (
    projectId: string,
    mode: TerminalChangesViewMode,
  ) => void;
  removeProjectPreview: (projectId: string) => void;
  createBrowserTab: (url?: string) => void;
  addProxyBrowserTab: (
    tabId: string,
    browserGroupId: string | undefined,
    url: string,
    title: string,
    openerTabId?: string,
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
