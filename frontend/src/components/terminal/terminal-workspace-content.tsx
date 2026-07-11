import { useMemoizedFn } from "ahooks";
import { useEffect, useMemo, useRef } from "react";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import type { TerminalState } from "@runweave/shared/terminal/state";
import type { ConnectionConfig } from "../../features/connection/types";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { useTerminalWorkspaceStore } from "../../features/terminal/workspace-store";
import {
  EMPTY_TERMINAL_PROJECTS,
  EMPTY_TERMINAL_SESSIONS,
  useTerminalProjectsQuery,
  useTerminalSessionsQuery,
} from "../../features/terminal/queries/terminal-workspace-queries";
import { useTerminalRuntime } from "../../features/terminal/queries/terminal-runtime-provider";
import { resolveCachedTerminalSurfaceIds } from "../../features/terminal/surface-cache";
import type { ClientMode } from "../../features/client-mode";
import {
  resolvePreferredProjectId,
  resolvePreferredSessionId,
  usePersistRecentSelection,
  useSessionMarkerCleanup,
  useSessionSelectionShortcuts,
} from "./terminal-workspace-effects";
import { useTerminalWorkspaceActions } from "./terminal-workspace-actions";
import { useTerminalWorkspaceEvents } from "./terminal-workspace-events";
import { TerminalWorkspaceShell } from "./terminal-workspace-shell";

const SESSION_RETRY_DELAY_MS = 2_000;

function hasValidProjectSessionSelection(
  projects: Array<{ projectId: string }>,
  sessions: TerminalSessionListItem[],
  projectId: string | null,
  terminalSessionId: string | null,
): boolean {
  if (!projectId || !terminalSessionId) {
    return false;
  }

  return (
    projects.some((project) => project.projectId === projectId) &&
    sessions.some(
      (session) =>
        session.projectId === projectId &&
        session.terminalSessionId === terminalSessionId,
    )
  );
}

export interface TerminalWorkspaceConnectionOptions {
  connections?: ConnectionConfig[];
  activeConnectionId?: string | null;
  connectionName?: string;
  onSelectConnection?: (connectionId: string) => void;
  onOpenConnectionManager?: () => void;
}

export interface TerminalWorkspaceProps {
  apiBase: string;
  token: string;
  clientMode?: ClientMode;
  connection?: TerminalWorkspaceConnectionOptions;
  initialTerminalSessionId?: string;
  onActiveSessionChange?: (terminalSessionId: string) => void;
  onNoSessionAvailable?: () => void;
  onNavigateHome?: () => void;
  onAuthExpired?: () => void;
  className?: string;
}
export function TerminalWorkspaceContent({
  apiBase,
  token,
  clientMode = "desktop",
  connection,
  initialTerminalSessionId,
  onActiveSessionChange,
  onNoSessionAvailable,
  onNavigateHome,
  onAuthExpired,
  className,
}: TerminalWorkspaceProps) {
  const {
    activeConnectionId,
    connectionName,
    connections,
    onOpenConnectionManager,
    onSelectConnection,
  } = connection ?? {};
  const { scope } = useTerminalRuntime();
  const projectsQuery = useTerminalProjectsQuery();
  const sessionsQuery = useTerminalSessionsQuery();
  const projects = projectsQuery.data ?? EMPTY_TERMINAL_PROJECTS;
  const sessions = sessionsQuery.data ?? EMPTY_TERMINAL_SESSIONS;
  const hasLoadedSessions = projectsQuery.isFetched && sessionsQuery.isFetched;
  const loading = projectsQuery.isPending || sessionsQuery.isPending;
  const queryError = projectsQuery.error ?? sessionsQuery.error;
  const requestError = queryError ? String(queryError) : null;
  const activeProjectId = useTerminalWorkspaceStore(
    (state) => state.activeProjectId,
  );
  const activeSessionId = useTerminalWorkspaceStore(
    (state) => state.activeSessionId,
  );
  const projectDialogMode = useTerminalWorkspaceStore(
    (state) => state.projectDialogMode,
  );
  const projectPendingDeletion = useTerminalWorkspaceStore(
    (state) => state.projectPendingDeletion,
  );
  const historyTerminalSessionId = useTerminalWorkspaceStore(
    (state) => state.historyTerminalSessionId,
  );
  const setActiveProjectId = useTerminalWorkspaceStore(
    (state) => state.setActiveProjectId,
  );
  const setActiveSessionId = useTerminalWorkspaceStore(
    (state) => state.setActiveSessionId,
  );
  const setTerminalStateBySessionId = useTerminalWorkspaceStore(
    (state) => state.setTerminalStateBySessionId,
  );
  const setCompletionMarkers = useTerminalWorkspaceStore(
    (state) => state.setCompletionMarkers,
  );
  const setBellMarkers = useTerminalWorkspaceStore(
    (state) => state.setBellMarkers,
  );
  const setCachedSurfaceSessionIds = useTerminalWorkspaceStore(
    (state) => state.setCachedSurfaceSessionIds,
  );
  const setHistoryDrawerOpen = useTerminalWorkspaceStore(
    (state) => state.setHistoryDrawerOpen,
  );
  const setHistoryTerminalSessionId = useTerminalWorkspaceStore(
    (state) => state.setHistoryTerminalSessionId,
  );
  const setHistoryTerminalPanelId = useTerminalWorkspaceStore(
    (state) => state.setHistoryTerminalPanelId,
  );
  const selectActiveSession = useTerminalWorkspaceStore(
    (state) => state.selectActiveSession,
  );
  const resetWorkspaceForConnection = useTerminalWorkspaceStore(
    (state) => state.resetForConnection,
  );
  const initialTerminalSessionIdRef = useRef(initialTerminalSessionId);
  const removeProjectPreview = useTerminalPreviewStore(
    (state) => state.removeProjectPreview,
  );

  const selectActiveProject = useMemoizedFn((projectId: string) => {
    setActiveProjectId(projectId);
    const projectSessions = sessions.filter(
      (session) => session.projectId === projectId,
    );
    const currentSessionId =
      useTerminalWorkspaceStore.getState().activeSessionId;
    if (
      currentSessionId &&
      projectSessions.some(
        (session) => session.terminalSessionId === currentSessionId,
      )
    ) {
      return;
    }
    selectActiveSession(
      resolvePreferredSessionId(scope, projectId, projectSessions),
    );
  });
  const visibleProjects = projects;
  const visibleSessions = useMemo(() => {
    if (!activeProjectId) {
      return [];
    }
    return sessions.filter((session) => session.projectId === activeProjectId);
  }, [activeProjectId, sessions]);
  const sessionIds = useMemo(
    () => sessions.map((session) => session.terminalSessionId),
    [sessions],
  );
  const activeSession = activeSessionId
    ? (visibleSessions.find(
        (session) => session.terminalSessionId === activeSessionId,
      ) ?? null)
    : null;
  const loadSessions = useMemoizedFn(async (): Promise<void> => {
    const [projectsResult, sessionsResult] = await Promise.all([
      projectsQuery.refetch(),
      sessionsQuery.refetch(),
    ]);
    const error = projectsResult.error ?? sessionsResult.error;
    if (error) {
      throw error;
    }
  });
  const { resetTerminalEventCursor } = useTerminalWorkspaceEvents({
    apiBase,
    token,
    onAuthExpired,
    loadSessions,
    selectActiveSession,
  });
  useEffect(() => {
    initialTerminalSessionIdRef.current = initialTerminalSessionId;
  }, [initialTerminalSessionId, setActiveSessionId]);
  useEffect(() => {
    resetWorkspaceForConnection(initialTerminalSessionIdRef.current);
    resetTerminalEventCursor();
  }, [resetTerminalEventCursor, resetWorkspaceForConnection, scope]);
  useEffect(() => {
    if (!requestError || loading) {
      return;
    }
    const retryTimer = window.setTimeout(() => {
      void loadSessions();
    }, SESSION_RETRY_DELAY_MS);
    return () => window.clearTimeout(retryTimer);
  }, [loadSessions, loading, requestError]);
  useEffect(() => {
    if (!initialTerminalSessionId) {
      return;
    }
    setActiveSessionId(initialTerminalSessionId);
  }, [initialTerminalSessionId, setActiveSessionId]);
  useEffect(() => {
    if (visibleProjects.length === 0) {
      return;
    }
    const activeSelectionIsValid = hasValidProjectSessionSelection(
      visibleProjects,
      sessions,
      activeProjectId,
      activeSessionId,
    );
    const desiredProjectId = resolvePreferredProjectId(
      scope,
      visibleProjects,
      sessions,
      activeProjectId,
      activeSelectionIsValid ? null : initialTerminalSessionId,
    );
    if (desiredProjectId) {
      setActiveProjectId(desiredProjectId);
      return;
    }
    setActiveProjectId(null);
  }, [
    activeProjectId,
    activeSessionId,
    initialTerminalSessionId,
    scope,
    sessions,
    setActiveProjectId,
    visibleProjects,
  ]);
  useEffect(() => {
    if (visibleSessions.length === 0) {
      if (!hasLoadedSessions) {
        return;
      }
      selectActiveSession(null);
      return;
    }
    if (
      activeSessionId &&
      visibleSessions.some(
        (session) => session.terminalSessionId === activeSessionId,
      )
    ) {
      return;
    }
    selectActiveSession(
      resolvePreferredSessionId(
        scope,
        activeProjectId ?? visibleSessions[0]!.projectId,
        visibleSessions,
        initialTerminalSessionId,
      ),
    );
  }, [
    activeProjectId,
    activeSessionId,
    hasLoadedSessions,
    initialTerminalSessionId,
    selectActiveSession,
    scope,
    visibleSessions,
  ]);
  useEffect(() => {
    if (!hasLoadedSessions || requestError) {
      return;
    }
    if (activeSession?.terminalSessionId) {
      onActiveSessionChange?.(activeSession.terminalSessionId);
    }
  }, [
    activeSession?.terminalSessionId,
    hasLoadedSessions,
    onActiveSessionChange,
    requestError,
  ]);
  useEffect(() => {
    setCachedSurfaceSessionIds((current) =>
      resolveCachedTerminalSurfaceIds({
        activeSessionId: activeSession?.terminalSessionId ?? null,
        cachedSessionIds: current,
        sessionIds,
      }),
    );
  }, [
    activeSession?.terminalSessionId,
    sessionIds,
    setCachedSurfaceSessionIds,
  ]);
  const activeProjectLoaded = Boolean(
    activeProjectId &&
    projects.some((project) => project.projectId === activeProjectId),
  );
  const canPersistRecentSelection =
    hasLoadedSessions &&
    !requestError &&
    activeProjectLoaded &&
    (visibleSessions.length === 0 || activeSession !== null);
  usePersistRecentSelection({
    apiBase: scope,
    activeProjectId,
    activeSessionId: activeSession?.terminalSessionId ?? null,
    canPersist: canPersistRecentSelection,
    requestError,
  });
  useSessionSelectionShortcuts({
    enabled: !projectDialogMode && !projectPendingDeletion,
    activeProjectId,
    activeSessionId: activeSession?.terminalSessionId ?? null,
    visibleProjects,
    visibleSessions,
    onSelectProject: selectActiveProject,
    onSelectSession: selectActiveSession,
  });
  const handleSelectSessionTab = useMemoizedFn((terminalSessionId: string) => {
    setCompletionMarkers((current) => {
      if (!current[terminalSessionId]) {
        return current;
      }
      const next = { ...current };
      delete next[terminalSessionId];
      return next;
    });
    selectActiveSession(terminalSessionId);
  });
  useEffect(() => {
    if (!hasLoadedSessions || requestError || sessions.length > 0) {
      return;
    }
    onNoSessionAvailable?.();
  }, [hasLoadedSessions, onNoSessionAvailable, requestError, sessions.length]);
  useEffect(() => {
    if (!activeSession?.terminalSessionId) {
      return;
    }
    setCompletionMarkers((current) => {
      if (!current[activeSession.terminalSessionId]) {
        return current;
      }
      const next = { ...current };
      delete next[activeSession.terminalSessionId];
      return next;
    });
  }, [activeSession?.terminalSessionId, setCompletionMarkers]);
  useEffect(() => {
    if (!activeSession?.terminalSessionId) {
      return;
    }
    setBellMarkers((current) => {
      if (!current[activeSession.terminalSessionId]) {
        return current;
      }
      const next = { ...current };
      delete next[activeSession.terminalSessionId];
      return next;
    });
  }, [activeSession?.terminalSessionId, setBellMarkers]);
  useSessionMarkerCleanup({
    sessions,
    historyTerminalSessionId,
    setCompletionMarkers,
    setBellMarkers,
    setHistoryDrawerOpen,
    setHistoryTerminalSessionId,
    setHistoryTerminalPanelId,
  });
  useEffect(() => {
    setTerminalStateBySessionId((current) => {
      const knownSessionIds = new Set(sessionIds);
      let changed = false;
      const next: Record<string, TerminalState> = {};
      for (const session of sessions) {
        const terminalSessionId = session.terminalSessionId;
        const terminalState =
          session.terminalState ?? current[terminalSessionId];
        if (!terminalState) {
          continue;
        }
        next[terminalSessionId] = terminalState;
        const previous = current[terminalSessionId];
        if (
          previous?.state !== terminalState.state ||
          previous.agent !== terminalState.agent
        ) {
          changed = true;
        }
      }
      if (Object.keys(current).some((id) => !knownSessionIds.has(id))) {
        changed = true;
      }
      return changed ? next : current;
    });
  }, [sessionIds, sessions, setTerminalStateBySessionId]);

  const {
    createSession,
    closeSession,
    updateSessionAlias,
    closeProjectDialog,
    submitProjectDialog,
    removeProject,
    handleProjectReorder,
    handleSessionReorder,
  } = useTerminalWorkspaceActions({
    apiBase,
    token,
    clientMode,
    selectActiveSession,
    removeProjectPreview,
    loadSessions,
    onAuthExpired,
  });
  return (
    <TerminalWorkspaceShell
      clientMode={clientMode}
      className={className}
      connection={{
        activeConnectionId,
        connectionName,
        connections,
        onNavigateHome,
        onOpenManager: onOpenConnectionManager,
        onSelect: onSelectConnection,
      }}
      projects={{
        onCloseDialog: closeProjectDialog,
        onConfirmDelete: () => void removeProject(),
        onReorder: handleProjectReorder,
        onSelect: selectActiveProject,
        onSubmitDialog: submitProjectDialog,
      }}
      sessions={{
        onReorder: handleSessionReorder,
        onRequestClose: (terminalSessionId) =>
          void closeSession(terminalSessionId),
        onRequestCreate: () => void createSession(),
        onSelect: handleSelectSessionTab,
        onSubmitAlias: updateSessionAlias,
      }}
    />
  );
}
