import { create } from "zustand";
import type { TerminalPanelWorkspace } from "@runweave/shared/terminal/panel";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import type { TerminalState } from "@runweave/shared/terminal/state";
import { resolveTerminalParentProjectId } from "@runweave/shared/terminal/project-context";

export type TerminalWorkspaceProjectDialogMode = "create" | "edit" | null;

export interface ProjectNavigationEntry {
  parentProjectId: string;
  projectId: string;
  terminalSessionId: string | null;
}

type StateUpdater<T> = T | ((current: T) => T);
const MAX_PROJECT_NAVIGATION_ENTRIES = 50;

interface TerminalWorkspaceState {
  activeParentProjectId: string | null;
  activeProjectId: string | null;
  activeSessionId: string | null;
  projectNavigationHistory: ProjectNavigationEntry[];
  projectNavigationIndex: number;
  hasLoadedSessions: boolean;
  loading: boolean;
  requestError: string | null;
  terminalStateBySessionId: Record<string, TerminalState>;
  panelWorkspaceBySessionId: Record<string, TerminalPanelWorkspace>;
  activePanelIdBySessionId: Record<string, string>;
  agentRecoveryRevisionBySessionId: Record<string, number>;
  completionMarkers: Record<string, number>;
  bellMarkers: Record<string, boolean>;
  cachedSurfaceSessionIds: string[];
  projectDialogMode: TerminalWorkspaceProjectDialogMode;
  projectDialogError: string | null;
  projectPendingDeletion: TerminalProjectListItem | null;
  historyTerminalSessionId: string | null;
  historyTerminalPanelId: string | null;
  historyDrawerOpen: boolean;
  aliasTargetSessionId: string | null;
  diagnosticLogOpen: boolean;
  statusLookupOpen: boolean;
}

interface TerminalWorkspaceActions {
  setActiveParentProjectId: (next: StateUpdater<string | null>) => void;
  setActiveProjectId: (next: StateUpdater<string | null>) => void;
  selectProjectContext: (
    parentProjectId: string | null,
    projectId: string | null,
    terminalSessionId: string | null,
  ) => void;
  navigateProjectHistory: (delta: -1 | 1) => void;
  reconcileProjectNavigationHistory: (
    projectIds: string[],
  ) => void;
  setActiveSessionId: (next: StateUpdater<string | null>) => void;
  setHasLoadedSessions: (next: StateUpdater<boolean>) => void;
  setLoading: (next: StateUpdater<boolean>) => void;
  setRequestError: (next: StateUpdater<string | null>) => void;
  setTerminalStateBySessionId: (
    next: StateUpdater<Record<string, TerminalState>>,
  ) => void;
  setPanelWorkspaceBySessionId: (
    next: StateUpdater<Record<string, TerminalPanelWorkspace>>,
  ) => void;
  setActivePanelIdBySessionId: (
    next: StateUpdater<Record<string, string>>,
  ) => void;
  bumpAgentRecoveryRevision: (terminalSessionId: string) => void;
  setCompletionMarkers: (next: StateUpdater<Record<string, number>>) => void;
  setBellMarkers: (next: StateUpdater<Record<string, boolean>>) => void;
  setCachedSurfaceSessionIds: (next: StateUpdater<string[]>) => void;
  setProjectDialogMode: (
    next: StateUpdater<TerminalWorkspaceProjectDialogMode>,
  ) => void;
  setProjectDialogError: (next: StateUpdater<string | null>) => void;
  setProjectPendingDeletion: (
    next: StateUpdater<TerminalProjectListItem | null>,
  ) => void;
  setHistoryTerminalSessionId: (next: StateUpdater<string | null>) => void;
  setHistoryTerminalPanelId: (next: StateUpdater<string | null>) => void;
  setHistoryDrawerOpen: (next: StateUpdater<boolean>) => void;
  openSessionAlias: (terminalSessionId: string) => void;
  closeSessionAlias: () => void;
  setDiagnosticLogOpen: (next: StateUpdater<boolean>) => void;
  setStatusLookupOpen: (next: StateUpdater<boolean>) => void;
  selectActiveSession: (terminalSessionId: string | null) => void;
  resetForConnection: (initialTerminalSessionId?: string) => void;
}

export type TerminalWorkspaceStore = TerminalWorkspaceState &
  TerminalWorkspaceActions;

export const TERMINAL_AGGREGATE_HAS_BELL = 1 << 0;
export const TERMINAL_AGGREGATE_HAS_COMPLETION = 1 << 1;
export const TERMINAL_AGGREGATE_IS_WORKING = 1 << 2;

export interface TerminalAggregateStatusMaps {
  byContextProjectId: Record<string, number>;
  byParentProjectId: Record<string, number>;
}

export function selectTerminalAggregateStatusMaps(
  state: Pick<
    TerminalWorkspaceStore,
    "bellMarkers" | "completionMarkers" | "terminalStateBySessionId"
  >,
  sessions: TerminalSessionListItem[],
): TerminalAggregateStatusMaps {
  const byContextProjectId: Record<string, number> = {};
  const byParentProjectId: Record<string, number> = {};

  for (const session of sessions) {
    let status = 0;
    if (state.bellMarkers[session.terminalSessionId]) {
      status |= TERMINAL_AGGREGATE_HAS_BELL;
    }
    if (state.completionMarkers[session.terminalSessionId]) {
      status |= TERMINAL_AGGREGATE_HAS_COMPLETION;
    }
    if (
      state.terminalStateBySessionId[session.terminalSessionId]?.state ===
      "agent_running"
    ) {
      status |= TERMINAL_AGGREGATE_IS_WORKING;
    }
    if (status === 0) {
      continue;
    }
    byContextProjectId[session.projectId] =
      (byContextProjectId[session.projectId] ?? 0) | status;
    const parentProjectId = resolveTerminalParentProjectId(session.projectId);
    byParentProjectId[parentProjectId] =
      (byParentProjectId[parentProjectId] ?? 0) | status;
  }

  return { byContextProjectId, byParentProjectId };
}

function resolveNext<T>(next: StateUpdater<T>, current: T): T {
  return typeof next === "function"
    ? (next as (current: T) => T)(current)
    : next;
}

function updateCurrentNavigationEntry(
  state: TerminalWorkspaceState,
  selection: ProjectNavigationEntry,
): Pick<TerminalWorkspaceState, "projectNavigationHistory" | "projectNavigationIndex"> {
  const { projectNavigationHistory: history, projectNavigationIndex: index } = state;
  if (index < 0) {
    return { projectNavigationHistory: [selection], projectNavigationIndex: 0 };
  }
  const current = history[index];
  if (current?.parentProjectId !== selection.parentProjectId) {
    const next = [...history.slice(0, index + 1), selection].slice(-MAX_PROJECT_NAVIGATION_ENTRIES);
    return {
      projectNavigationHistory: next,
      projectNavigationIndex: next.length - 1,
    };
  }
  if (current.projectId === selection.projectId &&
      current.terminalSessionId === selection.terminalSessionId) {
    return { projectNavigationHistory: history, projectNavigationIndex: index };
  }
  const next = [...history];
  next[index] = selection;
  return { projectNavigationHistory: next, projectNavigationIndex: index };
}

const initialState: TerminalWorkspaceState = {
  activeParentProjectId: null,
  activeProjectId: null,
  activeSessionId: null,
  projectNavigationHistory: [],
  projectNavigationIndex: -1,
  hasLoadedSessions: false,
  loading: false,
  requestError: null,
  terminalStateBySessionId: {},
  panelWorkspaceBySessionId: {},
  activePanelIdBySessionId: {},
  agentRecoveryRevisionBySessionId: {},
  completionMarkers: {},
  bellMarkers: {},
  cachedSurfaceSessionIds: [],
  projectDialogMode: null,
  projectDialogError: null,
  projectPendingDeletion: null,
  historyTerminalSessionId: null,
  historyTerminalPanelId: null,
  historyDrawerOpen: false,
  aliasTargetSessionId: null,
  diagnosticLogOpen: false,
  statusLookupOpen: false,
};

export const useTerminalWorkspaceStore = create<TerminalWorkspaceStore>(
  (set) => ({
    ...initialState,
    setActiveParentProjectId: (next) =>
      set((state) => ({
        activeParentProjectId: resolveNext(next, state.activeParentProjectId),
      })),
    setActiveProjectId: (next) =>
      set((state) => ({
        activeProjectId: resolveNext(next, state.activeProjectId),
      })),
    selectProjectContext: (
      parentProjectId,
      projectId,
      terminalSessionId,
    ) =>
      set((state) => ({
        activeParentProjectId: parentProjectId,
        activeProjectId: projectId,
        activeSessionId: terminalSessionId,
        ...(parentProjectId && projectId
          ? updateCurrentNavigationEntry(state, { parentProjectId, projectId, terminalSessionId })
          : {}),
      })),
    navigateProjectHistory: (delta) =>
      set((state) => {
        const index = state.projectNavigationIndex + delta;
        const entry = state.projectNavigationHistory[index];
        if (!entry) return state;
        return {
          projectNavigationIndex: index,
          activeParentProjectId: entry.parentProjectId,
          activeProjectId: entry.projectId,
          activeSessionId: entry.terminalSessionId,
        };
      }),
    reconcileProjectNavigationHistory: (projectIds) =>
      set((state) => {
        const availableProjects = new Set(projectIds);
        const history: ProjectNavigationEntry[] = [];
        let index = -1;
        state.projectNavigationHistory.forEach((entry, position) => {
          if (!availableProjects.has(entry.parentProjectId)) return;
          history.push(entry);
          if (position <= state.projectNavigationIndex) index = history.length - 1;
        });
        if (history.length === state.projectNavigationHistory.length &&
            index === state.projectNavigationIndex) return state;
        return { projectNavigationHistory: history, projectNavigationIndex: index };
      }),
    setActiveSessionId: (next) =>
      set((state) => {
        const terminalSessionId = resolveNext(next, state.activeSessionId);
        return {
          activeSessionId: terminalSessionId,
          ...(state.activeParentProjectId && state.activeProjectId &&
            resolveTerminalParentProjectId(state.activeProjectId) === state.activeParentProjectId
            ? updateCurrentNavigationEntry(state, {
                parentProjectId: state.activeParentProjectId,
                projectId: state.activeProjectId,
                terminalSessionId,
              })
            : {}),
        };
      }),
    setHasLoadedSessions: (next) =>
      set((state) => ({
        hasLoadedSessions: resolveNext(next, state.hasLoadedSessions),
      })),
    setLoading: (next) =>
      set((state) => ({ loading: resolveNext(next, state.loading) })),
    setRequestError: (next) =>
      set((state) => ({
        requestError: resolveNext(next, state.requestError),
      })),
    setTerminalStateBySessionId: (next) =>
      set((state) => ({
        terminalStateBySessionId: resolveNext(
          next,
          state.terminalStateBySessionId,
        ),
      })),
    setPanelWorkspaceBySessionId: (next) =>
      set((state) => ({
        panelWorkspaceBySessionId: resolveNext(
          next,
          state.panelWorkspaceBySessionId,
        ),
      })),
    setActivePanelIdBySessionId: (next) =>
      set((state) => ({
        activePanelIdBySessionId: resolveNext(
          next,
          state.activePanelIdBySessionId,
        ),
      })),
    bumpAgentRecoveryRevision: (terminalSessionId) =>
      set((state) => ({
        agentRecoveryRevisionBySessionId: {
          ...state.agentRecoveryRevisionBySessionId,
          [terminalSessionId]:
            (state.agentRecoveryRevisionBySessionId[terminalSessionId] ?? 0) +
            1,
        },
      })),
    setCompletionMarkers: (next) =>
      set((state) => ({
        completionMarkers: resolveNext(next, state.completionMarkers),
      })),
    setBellMarkers: (next) =>
      set((state) => ({
        bellMarkers: resolveNext(next, state.bellMarkers),
      })),
    setCachedSurfaceSessionIds: (next) =>
      set((state) => ({
        cachedSurfaceSessionIds: resolveNext(
          next,
          state.cachedSurfaceSessionIds,
        ),
      })),
    setProjectDialogMode: (next) =>
      set((state) => ({
        projectDialogMode: resolveNext(next, state.projectDialogMode),
      })),
    setProjectDialogError: (next) =>
      set((state) => ({
        projectDialogError: resolveNext(next, state.projectDialogError),
      })),
    setProjectPendingDeletion: (next) =>
      set((state) => ({
        projectPendingDeletion: resolveNext(next, state.projectPendingDeletion),
      })),
    setHistoryTerminalSessionId: (next) =>
      set((state) => ({
        historyTerminalSessionId: resolveNext(
          next,
          state.historyTerminalSessionId,
        ),
      })),
    setHistoryTerminalPanelId: (next) =>
      set((state) => ({
        historyTerminalPanelId: resolveNext(next, state.historyTerminalPanelId),
      })),
    setHistoryDrawerOpen: (next) =>
      set((state) => ({
        historyDrawerOpen: resolveNext(next, state.historyDrawerOpen),
      })),
    openSessionAlias: (terminalSessionId) =>
      set({ aliasTargetSessionId: terminalSessionId }),
    closeSessionAlias: () => set({ aliasTargetSessionId: null }),
    setDiagnosticLogOpen: (next) =>
      set((state) => ({
        diagnosticLogOpen: resolveNext(next, state.diagnosticLogOpen),
      })),
    setStatusLookupOpen: (next) =>
      set((state) => ({
        statusLookupOpen: resolveNext(next, state.statusLookupOpen),
      })),
    selectActiveSession: (terminalSessionId) =>
      set((state) => ({
        activeSessionId: terminalSessionId,
        ...(state.activeParentProjectId && state.activeProjectId &&
          resolveTerminalParentProjectId(state.activeProjectId) === state.activeParentProjectId
          ? updateCurrentNavigationEntry(state, {
              parentProjectId: state.activeParentProjectId,
              projectId: state.activeProjectId,
              terminalSessionId,
            })
          : {}),
      })),
    resetForConnection: (initialTerminalSessionId) =>
      set({
        ...initialState,
        activeSessionId: initialTerminalSessionId ?? null,
      }),
  }),
);
