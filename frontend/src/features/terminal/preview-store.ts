import { create } from "zustand";
import type { TerminalPreviewChangeKind } from "@browser-viewer/shared";

export type TerminalPreviewMode = "file" | "changes";
export type TerminalMarkdownViewMode = "source" | "split" | "preview";
export type TerminalSvgViewMode = "preview" | "source";
export type TerminalChangesViewMode = "diff" | "preview";

export const DEFAULT_MARKDOWN_VIEW_MODE: TerminalMarkdownViewMode = "preview";

interface TerminalPreviewUiState {
  open: boolean;
  widthPx?: number;
  expanded: boolean;
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
  openPreview: (projectId: string, mode?: TerminalPreviewMode) => void;
  closePreview: () => void;
  setWidth: (widthPx: number) => void;
  setExpanded: (expanded: boolean) => void;
  updateProjectPreview: (
    projectId: string,
    updates: Partial<TerminalPreviewProjectState>,
  ) => void;
  removeProjectPreview: (projectId: string) => void;
}

const DEFAULT_PROJECT_STATE: TerminalPreviewProjectState = {
  mode: null,
};

export const useTerminalPreviewStore = create<TerminalPreviewStore>((set) => ({
  ui: { open: false, expanded: false },
  projects: {},
  openPreview: (projectId, mode) => {
    set((state) => {
      const currentProject = state.projects[projectId] ?? DEFAULT_PROJECT_STATE;
      return {
        ui: { ...state.ui, open: true },
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
  closePreview: () => {
    set((state) => ({
      ui: { ...state.ui, open: false, expanded: false },
    }));
  },
  setWidth: (widthPx) => {
    set((state) => ({
      ui: { ...state.ui, widthPx },
    }));
  },
  setExpanded: (expanded) => {
    set((state) => ({
      ui: { ...state.ui, expanded },
    }));
  },
  updateProjectPreview: (projectId, updates) => {
    set((state) => ({
      projects: {
        ...state.projects,
        [projectId]: {
          ...(state.projects[projectId] ?? DEFAULT_PROJECT_STATE),
          ...updates,
        },
      },
    }));
  },
  removeProjectPreview: (projectId) => {
    set((state) => {
      const nextProjects = { ...state.projects };
      delete nextProjects[projectId];
      return { projects: nextProjects };
    });
  },
}));
