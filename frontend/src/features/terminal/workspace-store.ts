import { create } from "zustand";
import type {
  TerminalProjectListItem,
  TerminalSessionListItem,
  TerminalState,
} from "@runweave/shared";

export type TerminalWorkspaceProjectDialogMode = "create" | "edit" | null;

type StateUpdater<T> = T | ((current: T) => T);

interface TerminalWorkspaceState {
  projects: TerminalProjectListItem[];
  sessions: TerminalSessionListItem[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  hasLoadedSessions: boolean;
  loading: boolean;
  requestError: string | null;
  terminalStateBySessionId: Record<string, TerminalState>;
  completionMarkers: Record<string, boolean>;
  bellMarkers: Record<string, boolean>;
  cachedSurfaceSessionIds: string[];
  projectDialogMode: TerminalWorkspaceProjectDialogMode;
  projectDialogError: string | null;
  projectPendingDeletion: TerminalProjectListItem | null;
  historyTerminalSessionId: string | null;
  historyDrawerOpen: boolean;
}

interface TerminalWorkspaceActions {
  setProjects: (next: StateUpdater<TerminalProjectListItem[]>) => void;
  setSessions: (next: StateUpdater<TerminalSessionListItem[]>) => void;
  setActiveProjectId: (next: StateUpdater<string | null>) => void;
  setActiveSessionId: (next: StateUpdater<string | null>) => void;
  setHasLoadedSessions: (next: StateUpdater<boolean>) => void;
  setLoading: (next: StateUpdater<boolean>) => void;
  setRequestError: (next: StateUpdater<string | null>) => void;
  setTerminalStateBySessionId: (
    next: StateUpdater<Record<string, TerminalState>>,
  ) => void;
  setCompletionMarkers: (next: StateUpdater<Record<string, boolean>>) => void;
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
  setHistoryDrawerOpen: (next: StateUpdater<boolean>) => void;
  selectActiveSession: (terminalSessionId: string | null) => void;
  resetForConnection: (initialTerminalSessionId?: string) => void;
}

export type TerminalWorkspaceStore = TerminalWorkspaceState &
  TerminalWorkspaceActions;

function resolveNext<T>(next: StateUpdater<T>, current: T): T {
  return typeof next === "function"
    ? (next as (current: T) => T)(current)
    : next;
}

const initialState: TerminalWorkspaceState = {
  projects: [],
  sessions: [],
  activeProjectId: null,
  activeSessionId: null,
  hasLoadedSessions: false,
  loading: false,
  requestError: null,
  terminalStateBySessionId: {},
  completionMarkers: {},
  bellMarkers: {},
  cachedSurfaceSessionIds: [],
  projectDialogMode: null,
  projectDialogError: null,
  projectPendingDeletion: null,
  historyTerminalSessionId: null,
  historyDrawerOpen: false,
};

export const useTerminalWorkspaceStore = create<TerminalWorkspaceStore>(
  (set) => ({
    ...initialState,
    setProjects: (next) =>
      set((state) => ({ projects: resolveNext(next, state.projects) })),
    setSessions: (next) =>
      set((state) => ({ sessions: resolveNext(next, state.sessions) })),
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
        projectPendingDeletion: resolveNext(
          next,
          state.projectPendingDeletion,
        ),
      })),
    setHistoryTerminalSessionId: (next) =>
      set((state) => ({
        historyTerminalSessionId: resolveNext(
          next,
          state.historyTerminalSessionId,
        ),
      })),
    setHistoryDrawerOpen: (next) =>
      set((state) => ({
        historyDrawerOpen: resolveNext(next, state.historyDrawerOpen),
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
