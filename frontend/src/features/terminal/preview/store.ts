import { deviceStorage } from "../../device-storage";
import { create } from "zustand";
import type { StateCreator } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { TerminalPreviewChangeKind } from "@runweave/shared/terminal/preview";
import { TERMINAL_BROWSER_DEFAULT_PROFILE_ID } from "@runweave/shared/terminal-browser-profile";
import { LOCAL_DEV_CONNECTION_ID } from "../../connection/system-connection";
import {
  createInitialTerminalBrowserState,
  createTerminalPreviewBrowserActions,
} from "./browser-slice";
import type {
  TerminalChangesViewMode,
  TerminalMarkdownViewMode,
  TerminalPreviewMode,
  TerminalPreviewProjectState,
  TerminalPreviewStore,
  TerminalSidecarTool,
  TerminalSvgViewMode,
} from "./store-types";

export type {
  TerminalBrowserTabState,
  TerminalChangesViewMode,
  TerminalMarkdownViewMode,
  TerminalPreviewMode,
  TerminalPreviewProjectState,
  TerminalSidecarTool,
  TerminalSvgViewMode,
} from "./store-types";

export const DEFAULT_TERMINAL_SIDECAR_WIDTH = "clamp(320px, 60vw, 60vw)";
const TERMINAL_SIDECAR_WIDTH_STORAGE_KEY = "runweave.terminal.sidecar.width.v1";
const TERMINAL_PREVIEW_PROJECTS_STORAGE_KEY =
  "runweave.terminal.preview.projects.v1";
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
    const rawWidth = deviceStorage.getItem(
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
    deviceStorage.setItem(
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
  connectionScope: null,
  projectsByConnection: {},
  unassignedLegacyProjects: {},
  setConnectionScope: (connectionId) => {
    set((state: TerminalPreviewStore) => {
      if (state.connectionScope === connectionId) return state;
      const projectsByConnection = state.connectionScope
        ? { ...state.projectsByConnection, [state.connectionScope]: state.projects }
        : state.projectsByConnection;
      const useLegacy = connectionId === LOCAL_DEV_CONNECTION_ID &&
        !projectsByConnection[connectionId];
      return {
        connectionScope: connectionId,
        projectsByConnection,
        projects: projectsByConnection[connectionId] ??
          (useLegacy ? state.unassignedLegacyProjects : {}),
        unassignedLegacyProjects: useLegacy ? {} : state.unassignedLegacyProjects,
        changesRefreshRevisionByProjectId: {},
      };
    });
  },
  changesRefreshRevisionByProjectId: {},
  browser: createInitialTerminalBrowserState(),
  browserByProfile: {},
  activeBrowserProfileId: TERMINAL_BROWSER_DEFAULT_PROFILE_ID,
  browserActivationRevision: 0,
  browserActivationProjectId: null,
  openPreview: (projectId: string, mode?: TerminalPreviewMode) => {
    set((state: TerminalPreviewStore) => {
      const currentProject = state.projects[projectId] ?? DEFAULT_PROJECT_STATE;
      const nextMode = mode ?? currentProject.mode;
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
  openBrowser: (projectId) => {
    set((state: TerminalPreviewStore) => ({
      ui: { ...state.ui, open: true, activeTool: "browser" },
      browserActivationProjectId:
        projectId === undefined ? state.browserActivationProjectId : projectId,
      browserActivationRevision: state.browserActivationRevision + 1,
    }));
  },
  openAutomation: () => {
    set((state: TerminalPreviewStore) => ({
      ui: { ...state.ui, open: true, activeTool: "automation" },
    }));
  },
  activateBrowser: (profileId, projectId) => {
    set((state: TerminalPreviewStore) => {
      const browserByProfile = {
        ...state.browserByProfile,
        [state.activeBrowserProfileId]: state.browser,
      };
      return {
        ui: { ...state.ui, open: true, activeTool: "browser" },
        browserByProfile,
        browser:
          browserByProfile[profileId] ?? createInitialTerminalBrowserState(),
        activeBrowserProfileId: profileId,
        browserActivationProjectId: projectId,
        browserActivationRevision: state.browserActivationRevision + 1,
      };
    });
  },
  openAgentTeam: () => {
    set((state: TerminalPreviewStore) => ({
      ui: { ...state.ui, open: true, activeTool: "agent-team" },
    }));
  },
  openRace: () => {
    set((state: TerminalPreviewStore) => ({
      ui: { ...state.ui, open: true, activeTool: "race" },
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
  requestChangesRefresh: (projectId: string) => {
    set((state: TerminalPreviewStore) => ({
      changesRefreshRevisionByProjectId: {
        ...state.changesRefreshRevisionByProjectId,
        [projectId]:
          (state.changesRefreshRevisionByProjectId[projectId] ?? 0) + 1,
      },
    }));
  },
  removeProjectPreview: (projectId: string) => {
    set((state: TerminalPreviewStore) => {
      const nextProjects = { ...state.projects };
      const nextChangesRefreshRevisionByProjectId = {
        ...state.changesRefreshRevisionByProjectId,
      };
      delete nextProjects[projectId];
      delete nextChangesRefreshRevisionByProjectId[projectId];
      return {
        projects: nextProjects,
        changesRefreshRevisionByProjectId:
          nextChangesRefreshRevisionByProjectId,
      };
    });
  },
  ...createTerminalPreviewBrowserActions(set),
});

export const useTerminalPreviewStore = create<TerminalPreviewStore>()(
  persist(createTerminalPreviewStore, {
    name: TERMINAL_PREVIEW_PROJECTS_STORAGE_KEY,
    storage: createJSONStorage(() => deviceStorage),
    partialize: (state) => ({
      version: 2,
      projectsByConnection: state.connectionScope
        ? { ...state.projectsByConnection, [state.connectionScope]: state.projects }
        : state.projectsByConnection,
      unassignedLegacyProjects: state.unassignedLegacyProjects,
    }),
    merge: (persistedState, currentState) => {
      const saved = persistedState as {
        version?: number;
        projects?: Record<string, TerminalPreviewProjectState>;
        projectsByConnection?: Record<string, Record<string, TerminalPreviewProjectState>>;
        unassignedLegacyProjects?: Record<string, TerminalPreviewProjectState>;
      } | null;
      return {
        ...currentState,
        projectsByConnection: saved?.version === 2 ? saved.projectsByConnection ?? {} : {},
        unassignedLegacyProjects: saved?.version === 2
          ? saved.unassignedLegacyProjects ?? {}
          : saved?.projects ?? {},
      };
    },
  }),
);
