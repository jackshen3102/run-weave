import { create } from "zustand";
import type { StateCreator } from "zustand";
import type { TerminalPreviewChangeKind } from "@runweave/shared/terminal/preview";
import {
  createInitialTerminalBrowserState,
  createTerminalPreviewBrowserActions,
} from "./preview-browser-slice";
import type {
  TerminalChangesViewMode,
  TerminalMarkdownViewMode,
  TerminalPreviewMode,
  TerminalPreviewProjectState,
  TerminalPreviewStore,
  TerminalSidecarTool,
  TerminalSvgViewMode,
} from "./preview-store-types";

export type {
  TerminalBrowserTabState,
  TerminalChangesViewMode,
  TerminalMarkdownViewMode,
  TerminalPreviewMode,
  TerminalPreviewProjectState,
  TerminalSidecarTool,
  TerminalSvgViewMode,
} from "./preview-store-types";

export const DEFAULT_TERMINAL_SIDECAR_WIDTH = "clamp(320px, 60vw, 60vw)";
const TERMINAL_SIDECAR_WIDTH_STORAGE_KEY = "runweave.terminal.sidecar.width.v1";
export const DEFAULT_MARKDOWN_VIEW_MODE: TerminalMarkdownViewMode = "preview";

const DEFAULT_PROJECT_STATE: TerminalPreviewProjectState = {
  mode: null,
};

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

const createTerminalPreviewStore: StateCreator<TerminalPreviewStore> = (
  set,
) => ({
  ui: {
    open: true,
    widthPx: readStoredSidecarWidth(),
    expanded: false,
    activeTool: "preview",
  },
  projects: {},
  browser: createInitialTerminalBrowserState(),
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
  ...createTerminalPreviewBrowserActions(set),
});

export const useTerminalPreviewStore = create<TerminalPreviewStore>()(
  createTerminalPreviewStore,
);
