import { create } from "zustand";
import type { TerminalPanelWorkspace } from "@runweave/shared/terminal/panel";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import type { TerminalState } from "@runweave/shared/terminal/state";

export type TerminalWorkspaceProjectDialogMode = "create" | "edit" | null;

type StateUpdater<T> = T | ((current: T) => T);

interface TerminalWorkspaceState {
  activeProjectId: string | null;
  activeSessionId: string | null;
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
  setActiveProjectId: (next: StateUpdater<string | null>) => void;
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

export const TERMINAL_PROJECT_HAS_BELL = 1 << 0;
export const TERMINAL_PROJECT_HAS_COMPLETION = 1 << 1;
export const TERMINAL_PROJECT_IS_WORKING = 1 << 2;

export function selectTerminalProjectStatusById(
  state: Pick<
    TerminalWorkspaceStore,
    "bellMarkers" | "completionMarkers" | "terminalStateBySessionId"
  >,
  sessions: TerminalSessionListItem[],
): Record<string, number> {
  const statusByProjectId: Record<string, number> = {};

  for (const session of sessions) {
    let status = statusByProjectId[session.projectId] ?? 0;
    if (state.bellMarkers[session.terminalSessionId]) {
      status |= TERMINAL_PROJECT_HAS_BELL;
    }
    if (state.completionMarkers[session.terminalSessionId]) {
      status |= TERMINAL_PROJECT_HAS_COMPLETION;
    }
    if (
      state.terminalStateBySessionId[session.terminalSessionId]?.state ===
      "agent_running"
    ) {
      status |= TERMINAL_PROJECT_IS_WORKING;
    }
    if (status !== 0) {
      statusByProjectId[session.projectId] = status;
    }
  }

  return statusByProjectId;
}

function resolveNext<T>(next: StateUpdater<T>, current: T): T {
  return typeof next === "function"
    ? (next as (current: T) => T)(current)
    : next;
}

const initialState: TerminalWorkspaceState = {
  activeProjectId: null,
  activeSessionId: null,
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
    setActiveProjectId: (next) =>
      set((state) => ({
        activeProjectId: resolveNext(next, state.activeProjectId),
      })),
    setActiveSessionId: (next) =>
      set((state) => ({
        activeSessionId: resolveNext(next, state.activeSessionId),
      })),
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
      set({ activeSessionId: terminalSessionId }),
    resetForConnection: (initialTerminalSessionId) =>
      set({
        ...initialState,
        activeSessionId: initialTerminalSessionId ?? null,
      }),
  }),
);
