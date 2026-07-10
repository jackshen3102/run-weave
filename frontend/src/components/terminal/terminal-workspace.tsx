import { useMemoizedFn } from "ahooks";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TerminalSessionListItem, TerminalState } from "@runweave/shared";
import type { ConnectionConfig } from "../../features/connection/types";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { useTerminalWorkspaceStore } from "../../features/terminal/workspace-store";
import { resolveCachedTerminalSurfaceIds } from "../../features/terminal/surface-cache";
import type { ClientMode } from "../../features/client-mode";
import { HttpError } from "../../services/http";
import {
  listTerminalProjects,
  listTerminalSessions,
} from "../../services/terminal";
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

interface TerminalWorkspaceProps {
  apiBase: string;
  token: string;
  clientMode?: ClientMode;
  connections?: ConnectionConfig[];
  activeConnectionId?: string | null;
  connectionName?: string;
  onSelectConnection?: (connectionId: string) => void;
  onOpenConnectionManager?: () => void;
  initialTerminalSessionId?: string;
  onActiveSessionChange?: (terminalSessionId: string) => void;
  onNoSessionAvailable?: () => void;
  onNavigateHome?: () => void;
  onAuthExpired?: () => void;
  className?: string;
}
export function TerminalWorkspace({
  apiBase,
  token,
  clientMode = "desktop",
  connections,
  activeConnectionId,
  connectionName,
  onSelectConnection,
  onOpenConnectionManager,
  initialTerminalSessionId,
  onActiveSessionChange,
  onNoSessionAvailable,
  onNavigateHome,
  onAuthExpired,
  className,
}: TerminalWorkspaceProps) {
  const projects = useTerminalWorkspaceStore((state) => state.projects);
  const sessions = useTerminalWorkspaceStore((state) => state.sessions);
  const activeProjectId = useTerminalWorkspaceStore(
    (state) => state.activeProjectId,
  );
  const activeSessionId = useTerminalWorkspaceStore(
    (state) => state.activeSessionId,
  );
  const hasLoadedSessions = useTerminalWorkspaceStore(
    (state) => state.hasLoadedSessions,
  );
  const loading = useTerminalWorkspaceStore((state) => state.loading);
  const requestError = useTerminalWorkspaceStore((state) => state.requestError);
  const projectDialogMode = useTerminalWorkspaceStore(
    (state) => state.projectDialogMode,
  );
  const projectPendingDeletion = useTerminalWorkspaceStore(
    (state) => state.projectPendingDeletion,
  );
  const historyTerminalSessionId = useTerminalWorkspaceStore(
    (state) => state.historyTerminalSessionId,
  );
  const setProjects = useTerminalWorkspaceStore((state) => state.setProjects);
  const setSessions = useTerminalWorkspaceStore((state) => state.setSessions);
  const setActiveProjectId = useTerminalWorkspaceStore(
    (state) => state.setActiveProjectId,
  );
  const setActiveSessionId = useTerminalWorkspaceStore(
    (state) => state.setActiveSessionId,
  );
  const setHasLoadedSessions = useTerminalWorkspaceStore(
    (state) => state.setHasLoadedSessions,
  );
  const setLoading = useTerminalWorkspaceStore((state) => state.setLoading);
  const setRequestError = useTerminalWorkspaceStore(
    (state) => state.setRequestError,
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
  const loadSessionsRequestIdRef = useRef(0);
  const currentApiBaseRef = useRef(apiBase);
  const initialTerminalSessionIdRef = useRef(initialTerminalSessionId);
  const [sessionsLoadedApiBase, setSessionsLoadedApiBase] = useState<
    string | null
  >(null);
  const removeProjectPreview = useTerminalPreviewStore(
    (state) => state.removeProjectPreview,
  );

  const selectActiveProject = useMemoizedFn((projectId: string) => {
    setActiveProjectId(projectId);
    const currentState = useTerminalWorkspaceStore.getState();
    const projectSessions = currentState.sessions.filter(
      (session) => session.projectId === projectId,
    );
    const currentSessionId = currentState.activeSessionId;
    if (
      currentSessionId &&
      projectSessions.some(
        (session) => session.terminalSessionId === currentSessionId,
      )
    ) {
      return;
    }
    selectActiveSession(
      resolvePreferredSessionId(apiBase, projectId, projectSessions),
    );
  });
  const visibleProjects = useMemo(() => {
    return [...projects];
  }, [projects]);
  const visibleSessions = useMemo(() => {
    if (!activeProjectId) {
      return [];
    }
    return sessions.filter((session) =>
      session.projectId === activeProjectId,
    );
  }, [activeProjectId, sessions]);
  const sessionIds = useMemo(
    () => sessions.map((session) => session.terminalSessionId),
    [sessions],
  );
  const activeSession =
    activeSessionId
      ? visibleSessions.find(
          (session) => session.terminalSessionId === activeSessionId,
        ) ?? null
      : null;
  const loadSessions = useMemoizedFn(async (): Promise<void> => {
    const requestId = loadSessionsRequestIdRef.current + 1;
    loadSessionsRequestIdRef.current = requestId;
    const requestApiBase = apiBase;
    const isCurrentRequest = (): boolean =>
      loadSessionsRequestIdRef.current === requestId &&
      currentApiBaseRef.current === requestApiBase;
    setLoading(true);
    try {
      const [nextProjects, nextSessions] = await Promise.all([
        listTerminalProjects(apiBase, token),
        listTerminalSessions(apiBase, token),
      ]);
      if (!isCurrentRequest()) {
        return;
      }
      setProjects(nextProjects);
      setSessions(nextSessions);
      setTerminalStateBySessionId((current) => {
        const knownSessionIds = new Set(
          nextSessions.map((session) => session.terminalSessionId),
        );
        let changed = false;
        const next: Record<string, TerminalState> = {};
        for (const session of nextSessions) {
          const terminalSessionId = session.terminalSessionId;
          const terminalState = session.terminalState;
          if (terminalState) {
            const currentState = current[terminalSessionId];
            next[terminalSessionId] = terminalState;
            if (
              currentState?.state !== terminalState.state ||
              currentState.agent !== terminalState.agent
            ) {
              changed = true;
            }
            continue;
          }
          if (current[terminalSessionId]) {
            next[terminalSessionId] = current[terminalSessionId];
          }
        }
        if (Object.keys(current).some((id) => !knownSessionIds.has(id))) {
          changed = true;
        }
        return changed ? next : current;
      });
      const currentState = useTerminalWorkspaceStore.getState();
      const currentSelectionIsValid = hasValidProjectSessionSelection(
        nextProjects,
        nextSessions,
        currentState.activeProjectId,
        currentState.activeSessionId,
      );
      const nextActiveProjectId = resolvePreferredProjectId(
        apiBase,
        nextProjects,
        nextSessions,
        currentState.activeProjectId,
        currentSelectionIsValid ? null : initialTerminalSessionId,
      );
      setActiveProjectId(nextActiveProjectId);
      if (!nextActiveProjectId) {
        selectActiveSession(null);
      } else {
        const nextProjectSessions = nextSessions.filter(
          (session) => session.projectId === nextActiveProjectId,
        );
        const currentActiveSessionId = currentState.activeSessionId;
        const currentSessionStillValid =
          currentActiveSessionId &&
          nextProjectSessions.some(
            (session) => session.terminalSessionId === currentActiveSessionId,
          );
        selectActiveSession(
          currentSessionStillValid
            ? currentActiveSessionId
            : resolvePreferredSessionId(
                apiBase,
                nextActiveProjectId,
                nextProjectSessions,
                initialTerminalSessionId,
              ),
        );
      }
      setSessionsLoadedApiBase(requestApiBase);
      setRequestError(null);
    } catch (error) {
      if (!isCurrentRequest()) {
        return;
      }
      if (error instanceof HttpError && error.status === 401) {
        onAuthExpired?.();
        return;
      }
      setRequestError(String(error));
    } finally {
      if (isCurrentRequest()) {
        setHasLoadedSessions(true);
        setLoading(false);
      }
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
    loadSessionsRequestIdRef.current += 1;
    currentApiBaseRef.current = apiBase;
    setSessionsLoadedApiBase(null);
    resetWorkspaceForConnection(initialTerminalSessionIdRef.current);
    resetTerminalEventCursor();
  }, [apiBase, resetTerminalEventCursor, resetWorkspaceForConnection]);
  useEffect(() => {
    void loadSessions();
  }, [apiBase, initialTerminalSessionId, loadSessions, token]);
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
      apiBase,
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
    apiBase,
    initialTerminalSessionId,
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
        apiBase,
        activeProjectId ?? visibleSessions[0]!.projectId,
        visibleSessions,
        initialTerminalSessionId,
      ),
    );
  }, [
    activeProjectId,
    activeSessionId,
    apiBase,
    hasLoadedSessions,
    initialTerminalSessionId,
    selectActiveSession,
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
    sessionsLoadedApiBase === apiBase &&
    hasLoadedSessions &&
    !requestError &&
    activeProjectLoaded &&
    (visibleSessions.length === 0 || activeSession !== null);
  usePersistRecentSelection({
    apiBase,
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
    const knownSessionIds = new Set(sessionIds);
    setTerminalStateBySessionId((current) => {
      let changed = false;
      const next: Record<string, TerminalState> = {};
      for (const [terminalSessionId, terminalState] of Object.entries(
        current,
      )) {
        if (knownSessionIds.has(terminalSessionId)) {
          next[terminalSessionId] = terminalState;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [sessionIds, setTerminalStateBySessionId]);

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
      apiBase={apiBase}
      token={token}
      clientMode={clientMode}
      className={className}
      connections={connections}
      activeConnectionId={activeConnectionId}
      connectionName={connectionName}
      onSelectConnection={onSelectConnection}
      onOpenConnectionManager={onOpenConnectionManager}
      onNavigateHome={onNavigateHome}
      onAuthExpired={onAuthExpired}
      onSelectProject={selectActiveProject}
      onSelectSession={handleSelectSessionTab}
      onRequestCreateSession={() => {
        void createSession();
      }}
      onRequestCloseSession={(terminalSessionId) => {
        void closeSession(terminalSessionId);
      }}
      onSubmitSessionAlias={updateSessionAlias}
      onCloseProjectDialog={closeProjectDialog}
      onSubmitProjectDialog={submitProjectDialog}
      onConfirmDeleteProject={() => {
        void removeProject();
      }}
      onReorderProjects={handleProjectReorder}
      onReorderSessions={handleSessionReorder}
    />
  );
}
