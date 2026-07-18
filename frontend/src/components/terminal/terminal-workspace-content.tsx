import { useMemoizedFn } from "ahooks";
import { useEffect, useMemo, useRef } from "react";
import type { TerminalState } from "@runweave/shared/terminal/state";
import { resolveTerminalParentProjectId } from "@runweave/shared/terminal/project-context";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { useTerminalWorkspaceStore } from "../../features/terminal/workspace-store";
import {
  EMPTY_TERMINAL_PROJECTS,
  EMPTY_TERMINAL_PROJECT_CONTEXTS,
  EMPTY_TERMINAL_SESSIONS,
  updateTerminalSessions,
  useTerminalProjectsQuery,
  useTerminalProjectContextsQuery,
  useTerminalSessionsQuery,
  useTerminalWorkspaceQueryClient,
} from "../../features/terminal/queries/terminal-workspace-queries";
import { loadRecentTerminalSelection } from "../../features/terminal/recent-selection";
import { useTerminalRuntime } from "../../features/terminal/queries/terminal-runtime-provider";
import { resolveCachedTerminalSurfaceIds } from "../../features/terminal/surface-cache";
import { HttpError } from "../../services/http";
import { updateTerminalSession } from "../../services/terminal";
import {
  hasValidProjectSessionSelection,
  resolvePreferredProjectId,
  resolvePreferredSessionId,
  selectTerminalProjectContext,
  usePersistRecentSelection,
  useSessionMarkerCleanup,
  useSessionSelectionShortcuts,
} from "./terminal-workspace-effects";
import { useTerminalWorkspaceActions } from "./terminal-workspace-actions";
import { useTerminalWorkspaceEvents } from "./terminal-workspace-events";
import { TerminalWorkspaceShell } from "./terminal-workspace-shell";
import type { TerminalWorkspaceProps } from "./terminal-workspace-types";

const SESSION_RETRY_DELAY_MS = 2_000;

export type { TerminalWorkspaceProps } from "./terminal-workspace-types";

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
  const { queryClient } = useTerminalWorkspaceQueryClient();
  const projects = projectsQuery.data ?? EMPTY_TERMINAL_PROJECTS;
  const sessions = sessionsQuery.data ?? EMPTY_TERMINAL_SESSIONS;
  const hasLoadedSessions = projectsQuery.isFetched && sessionsQuery.isFetched;
  const activeParentProjectId = useTerminalWorkspaceStore(
    (state) => state.activeParentProjectId,
  );
  const contextsQuery = useTerminalProjectContextsQuery(activeParentProjectId);
  const contexts =
    contextsQuery.data ?? EMPTY_TERMINAL_PROJECT_CONTEXTS;
  const loading =
    projectsQuery.isPending ||
    sessionsQuery.isPending ||
    Boolean(activeParentProjectId && contextsQuery.isPending);
  const queryError =
    projectsQuery.error ?? sessionsQuery.error ?? contextsQuery.error;
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
  const setActiveParentProjectId = useTerminalWorkspaceStore(
    (state) => state.setActiveParentProjectId,
  );
  const selectProjectContext = useTerminalWorkspaceStore(
    (state) => state.selectProjectContext,
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
    const recentSelection = loadRecentTerminalSelection(scope);
    const storedContextId =
      recentSelection?.contextProjectIdByParentProjectId[projectId];
    const effectiveProjectId =
      storedContextId &&
      resolveTerminalParentProjectId(storedContextId) === projectId
        ? storedContextId
        : projectId;
    const projectSessions = sessions.filter(
      (session) => session.projectId === effectiveProjectId,
    );
    const currentSessionId =
      useTerminalWorkspaceStore.getState().activeSessionId;
    if (
      currentSessionId &&
      projectSessions.some(
        (session) => session.terminalSessionId === currentSessionId,
      )
    ) {
      selectProjectContext(projectId, effectiveProjectId, currentSessionId);
      return;
    }
    selectProjectContext(
      projectId,
      effectiveProjectId,
      resolvePreferredSessionId(scope, effectiveProjectId, projectSessions),
    );
  });
  const selectActiveContext = useMemoizedFn((projectId: string) => {
    selectTerminalProjectContext({
      activeParentProjectId,
      projectId,
      sessions,
      scope,
      selectProjectContext,
    });
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
      activeParentProjectId,
      activeProjectId,
      activeSessionId,
    );
    const desiredProjectId = resolvePreferredProjectId(
      scope,
      visibleProjects,
      sessions,
      activeParentProjectId,
      activeSelectionIsValid ? null : initialTerminalSessionId,
    );
    if (desiredProjectId) {
      setActiveParentProjectId(desiredProjectId);
      return;
    }
    selectProjectContext(null, null, null);
  }, [
    activeParentProjectId,
    activeProjectId,
    activeSessionId,
    initialTerminalSessionId,
    scope,
    sessions,
    setActiveParentProjectId,
    selectProjectContext,
    visibleProjects,
  ]);
  useEffect(() => {
    if (!activeParentProjectId || contextsQuery.isPending) {
      return;
    }
    const recentSelection = loadRecentTerminalSelection(scope);
    const initialSessionProjectId = initialTerminalSessionId
      ? sessions.find(
          (session) => session.terminalSessionId === initialTerminalSessionId,
        )?.projectId
      : null;
    const storedContextId =
      recentSelection?.contextProjectIdByParentProjectId[
        activeParentProjectId
      ];
    const isKnownContext = (projectId: string | null | undefined): projectId is string =>
      Boolean(
        projectId &&
          resolveTerminalParentProjectId(projectId) === activeParentProjectId &&
          (projectId === activeParentProjectId ||
            contexts.some((context) => context.projectId === projectId) ||
            sessions.some((session) => session.projectId === projectId)),
      );
    const desiredContextId = [
      activeProjectId,
      initialSessionProjectId,
      storedContextId,
      activeParentProjectId,
    ].find(isKnownContext);
    if (!desiredContextId) {
      return;
    }
    const projectSessions = sessions.filter(
      (session) => session.projectId === desiredContextId,
    );
    const desiredSessionId = resolvePreferredSessionId(
      scope,
      desiredContextId,
      projectSessions,
      initialTerminalSessionId,
    );
    if (
      activeProjectId === desiredContextId &&
      activeSessionId === desiredSessionId
    ) {
      return;
    }
    selectProjectContext(
      activeParentProjectId,
      desiredContextId,
      desiredSessionId,
    );
  }, [
    activeParentProjectId,
    activeProjectId,
    activeSessionId,
    contexts,
    contextsQuery.isPending,
    initialTerminalSessionId,
    scope,
    selectProjectContext,
    sessions,
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
    activeParentProjectId &&
    activeProjectId &&
    projects.some(
      (project) => project.projectId === activeParentProjectId,
    ) &&
    (activeProjectId === activeParentProjectId ||
      contexts.some((context) => context.projectId === activeProjectId)),
  );
  const canPersistRecentSelection =
    hasLoadedSessions &&
    contextsQuery.isFetched &&
    !requestError &&
    activeProjectLoaded &&
    (visibleSessions.length === 0 || activeSession !== null);
  const handleSelectSessionTab = useMemoizedFn((terminalSessionId: string) => {
    const completionRevision =
      useTerminalWorkspaceStore.getState().completionMarkers[
        terminalSessionId
      ];
    selectActiveSession(terminalSessionId);
    if (!completionRevision) {
      return;
    }
    setCompletionMarkers((current) => {
      if (current[terminalSessionId] !== completionRevision) {
        return current;
      }
      const next = { ...current };
      delete next[terminalSessionId];
      return next;
    });
    void updateTerminalSession(apiBase, token, terminalSessionId, {
      acknowledgedCompletionRevision: completionRevision,
    })
      .then((updatedSession) => {
        updateTerminalSessions(queryClient, scope, (currentSessions) =>
          currentSessions.map((session) =>
            session.terminalSessionId === terminalSessionId
              ? updatedSession
              : session,
          ),
        );
      })
      .catch((error) => {
        setCompletionMarkers((current) => ({
          ...current,
          [terminalSessionId]: Math.max(
            current[terminalSessionId] ?? 0,
            completionRevision,
          ),
        }));
        if (error instanceof HttpError && error.status === 401) {
          onAuthExpired?.();
        }
      });
  });
  usePersistRecentSelection({
    apiBase: scope,
    activeParentProjectId,
    activeProjectId,
    activeSessionId: activeSession?.terminalSessionId ?? null,
    canPersist: canPersistRecentSelection,
    requestError,
  });
  useSessionSelectionShortcuts({
    enabled: !projectDialogMode && !projectPendingDeletion,
    activeProjectId: activeParentProjectId,
    activeSessionId: activeSession?.terminalSessionId ?? null,
    visibleProjects,
    visibleSessions,
    onSelectProject: selectActiveProject,
    onSelectSession: handleSelectSessionTab,
  });
  useEffect(() => {
    if (!hasLoadedSessions || requestError || sessions.length > 0) {
      return;
    }
    onNoSessionAvailable?.();
  }, [hasLoadedSessions, onNoSessionAvailable, requestError, sessions.length]);
  useEffect(() => {
    setCompletionMarkers((current) => {
      let changed = false;
      const next = { ...current };
      for (const session of sessions) {
        const currentRevision = next[session.terminalSessionId] ?? 0;
        if (
          currentRevision > 0 &&
          currentRevision <= session.acknowledgedCompletionRevision
        ) {
          delete next[session.terminalSessionId];
          changed = true;
        }
        if (
          session.completionRevision <=
            session.acknowledgedCompletionRevision ||
          currentRevision >= session.completionRevision
        ) {
          continue;
        }
        next[session.terminalSessionId] = session.completionRevision;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [sessions, setCompletionMarkers]);
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
        onSelectContext: selectActiveContext,
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
