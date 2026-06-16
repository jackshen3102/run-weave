import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  TerminalProjectListItem,
  TerminalSessionListItem,
  TerminalState,
} from "@runweave/shared";
import type { ConnectionConfig } from "../../features/connection/types";
import {
  DEFAULT_TERMINAL_SIDECAR_WIDTH,
  useTerminalPreviewStore,
} from "../../features/terminal/preview-store";
import { resolveCachedTerminalSurfaceIds } from "../../features/terminal/surface-cache";
import { formatTerminalSessionName } from "../../features/terminal/session-name";
import type { ClientMode } from "../../features/client-mode";
import { HttpError } from "../../services/http";
import {
  listTerminalProjects,
  listTerminalSessions,
} from "../../services/terminal";
import {
  resolvePreferredSessionId,
  usePersistRecentSelection,
  useSessionMarkerCleanup,
  useSessionSelectionShortcuts,
} from "./terminal-workspace-effects";
import { useTerminalWorkspaceActions } from "./terminal-workspace-actions";
import { useTerminalWorkspaceEvents } from "./terminal-workspace-events";
import { TerminalWorkspaceShell } from "./terminal-workspace-shell";
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
  const [projects, setProjects] = useState<TerminalProjectListItem[]>([]);
  const [sessions, setSessions] = useState<TerminalSessionListItem[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    initialTerminalSessionId ?? null,
  );
  const [hasLoadedSessions, setHasLoadedSessions] = useState(false);
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [terminalStateBySessionId, setTerminalStateBySessionId] = useState<
    Record<string, TerminalState>
  >({});
  const [completionMarkers, setCompletionMarkers] = useState<
    Record<string, boolean>
  >({});
  const [bellMarkers, setBellMarkers] = useState<Record<string, boolean>>({});
  const [cachedSurfaceSessionIds, setCachedSurfaceSessionIds] = useState<
    string[]
  >([]);
  const [projectDialogMode, setProjectDialogMode] = useState<
    "create" | "edit" | null
  >(null);
  const [projectDialogError, setProjectDialogError] = useState<string | null>(
    null,
  );
  const [projectPendingDeletion, setProjectPendingDeletion] =
    useState<TerminalProjectListItem | null>(null);
  const [historyTerminalSessionId, setHistoryTerminalSessionId] = useState<
    string | null
  >(null);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const loadSessionsRequestIdRef = useRef(0);
  const currentApiBaseRef = useRef(apiBase);
  const activeSessionIdRef = useRef(activeSessionId);
  const sessionsRef = useRef<TerminalSessionListItem[]>([]);
  const terminalStateBySessionIdRef = useRef(terminalStateBySessionId);
  const isMobileMonitor = clientMode === "mobile";
  const previewOpen = useTerminalPreviewStore((state) => state.ui.open);
  const previewWidthPx = useTerminalPreviewStore((state) => state.ui.widthPx);
  const previewExpanded = useTerminalPreviewStore((state) => state.ui.expanded);
  const setPreviewActiveTool = useTerminalPreviewStore(
    (state) => state.setActiveTool,
  );
  const previewReservedWidth = previewWidthPx
    ? `${previewWidthPx}px`
    : DEFAULT_TERMINAL_SIDECAR_WIDTH;
  const terminalLayoutVersion = isMobileMonitor
    ? "mobile"
    : `desktop:${previewOpen ? previewReservedWidth : "full"}`;
  const removeProjectPreview = useTerminalPreviewStore(
    (state) => state.removeProjectPreview,
  );

  const selectActiveSession = useCallback(
    (terminalSessionId: string | null) => {
      activeSessionIdRef.current = terminalSessionId;
      setActiveSessionId(terminalSessionId);
    },
    [],
  );
  const selectActiveProject = useCallback(
    (projectId: string) => {
      setActiveProjectId(projectId);
      const currentSessionId = activeSessionIdRef.current;
      if (
        currentSessionId &&
        sessionsRef.current.some(
          (session) =>
            session.terminalSessionId === currentSessionId &&
            session.projectId === projectId,
        )
      ) {
        return;
      }
      selectActiveSession(
        resolvePreferredSessionId(apiBase, projectId, sessionsRef.current),
      );
    },
    [apiBase, selectActiveSession],
  );
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    terminalStateBySessionIdRef.current = terminalStateBySessionId;
  }, [terminalStateBySessionId]);
  const visibleProjects = useMemo(() => {
    return [...projects];
  }, [projects]);
  const visibleSessions = useMemo(() => {
    return sessions.filter((session) =>
      activeProjectId ? session.projectId === activeProjectId : true,
    );
  }, [activeProjectId, sessions]);
  const sessionIds = useMemo(
    () => sessions.map((session) => session.terminalSessionId),
    [sessions],
  );
  const cachedSurfaceSessionIdSet = useMemo(
    () => new Set(cachedSurfaceSessionIds),
    [cachedSurfaceSessionIds],
  );
  const activeProject =
    visibleProjects.find((project) => project.projectId === activeProjectId) ??
    null;
  const activeSession =
    visibleSessions.find(
      (session) => session.terminalSessionId === activeSessionId,
    ) ??
    visibleSessions[0] ??
    null;
  const loadSessions = useCallback(async (): Promise<void> => {
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
      setActiveProjectId((currentProjectId) => {
        if (
          currentProjectId &&
          nextProjects.some((project) => project.projectId === currentProjectId)
        ) {
          return currentProjectId;
        }
        const initialSessionProjectId = nextSessions.find(
          (session) => session.terminalSessionId === initialTerminalSessionId,
        )?.projectId;
        return initialSessionProjectId ?? nextProjects[0]?.projectId ?? null;
      });
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
  }, [apiBase, initialTerminalSessionId, onAuthExpired, token]);
  const { resetTerminalEventCursor } = useTerminalWorkspaceEvents({
    apiBase,
    token,
    sessionsRef,
    activeSessionIdRef,
    onAuthExpired,
    setTerminalStateBySessionId,
    setCompletionMarkers,
    loadSessions,
    setActiveProjectId,
    selectActiveSession,
  });
  useEffect(() => {
    loadSessionsRequestIdRef.current += 1;
    currentApiBaseRef.current = apiBase;
    setProjects([]);
    setSessions([]);
    setActiveProjectId(null);
    setActiveSessionId(null);
    setHasLoadedSessions(false);
    setRequestError(null);
    setTerminalStateBySessionId({});
    setCompletionMarkers({});
    setBellMarkers({});
    setCachedSurfaceSessionIds([]);
    resetTerminalEventCursor();
  }, [apiBase, resetTerminalEventCursor]);
  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);
  useEffect(() => {
    if (!initialTerminalSessionId) {
      return;
    }
    setActiveSessionId(initialTerminalSessionId);
  }, [initialTerminalSessionId]);
  useEffect(() => {
    if (visibleProjects.length === 0) {
      return;
    }
    const initialSessionProjectId = sessions.find(
      (session) => session.terminalSessionId === initialTerminalSessionId,
    )?.projectId;
    const desiredProjectId = activeProjectId ?? initialSessionProjectId;
    if (
      desiredProjectId &&
      visibleProjects.some((project) => project.projectId === desiredProjectId)
    ) {
      setActiveProjectId(desiredProjectId);
      return;
    }
    setActiveProjectId(visibleProjects[0]?.projectId ?? null);
  }, [activeProjectId, initialTerminalSessionId, sessions, visibleProjects]);
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
      ),
    );
  }, [
    activeProjectId,
    activeSessionId,
    apiBase,
    hasLoadedSessions,
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
  }, [activeSession?.terminalSessionId, sessionIds]);
  usePersistRecentSelection({
    apiBase,
    activeProjectId,
    activeSessionId: activeSession?.terminalSessionId ?? null,
    hasLoadedSessions,
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
  }, [activeSession?.terminalSessionId]);
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
  }, [activeSession?.terminalSessionId]);
  useSessionMarkerCleanup({
    sessions,
    historyTerminalSessionId,
    setCompletionMarkers,
    setBellMarkers,
    setHistoryDrawerOpen,
    setHistoryTerminalSessionId,
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
  }, [sessionIds]);

  const {
    createSession,
    closeSession,
    updateSessionAlias,
    closeProjectDialog,
    submitProjectDialog,
    removeProject,
    handleSessionMetadata,
    handleSessionBell,
    handleProjectReorder,
    handleSessionReorder,
    openHistoryDrawer,
  } = useTerminalWorkspaceActions({
    apiBase,
    token,
    clientMode,
    loading,
    activeProjectId,
    activeProject,
    activeSession,
    projectDialogMode,
    projectPendingDeletion,
    setProjects,
    setSessions,
    setLoading,
    setRequestError,
    setProjectDialogMode,
    setProjectDialogError,
    setProjectPendingDeletion,
    setHistoryDrawerOpen,
    setHistoryTerminalSessionId,
    setBellMarkers,
    setActiveProjectId,
    setActiveSessionId,
    selectActiveSession,
    removeProjectPreview,
    loadSessions,
    onAuthExpired,
  });
  const historySession =
    sessions.find(
      (session) => session.terminalSessionId === historyTerminalSessionId,
    ) ?? null;
  const historyTerminalName = historySession
    ? formatTerminalSessionName({
        alias: historySession.alias,
        cwd: historySession.cwd,
        activeCommand: historySession.activeCommand,
      })
    : undefined;
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
      loading={loading}
      requestError={requestError}
      isMobileMonitor={isMobileMonitor}
      visibleProjects={visibleProjects}
      visibleSessions={visibleSessions}
      sessions={sessions}
      activeProjectId={activeProjectId}
      activeProject={activeProject}
      activeSession={activeSession}
      previewOpen={previewOpen}
      previewExpanded={previewExpanded}
      previewWidthPx={previewWidthPx ?? undefined}
      previewReservedWidth={previewReservedWidth}
      cachedSurfaceSessionIdSet={cachedSurfaceSessionIdSet}
      historyDrawerOpen={historyDrawerOpen}
      historyTerminalSessionId={historyTerminalSessionId}
      historyTerminalName={historyTerminalName}
      projectDialogMode={projectDialogMode}
      projectDialogError={projectDialogError}
      projectPendingDeletion={projectPendingDeletion}
      completionMarkers={completionMarkers}
      bellMarkers={bellMarkers}
      terminalStateBySessionId={terminalStateBySessionId}
      terminalLayoutVersion={terminalLayoutVersion}
      onSelectProject={selectActiveProject}
      onSelectSession={selectActiveSession}
      onRequestCreateProject={() => {
        setPreviewActiveTool("preview");
        setProjectDialogError(null);
        setProjectDialogMode("create");
      }}
      onRequestEditProject={(projectId) => {
        setPreviewActiveTool("preview");
        if (projectId) {
          setActiveProjectId(projectId);
        }
        setProjectDialogError(null);
        setProjectDialogMode("edit");
      }}
      onRequestDeleteProject={(project) => {
        setPreviewActiveTool("preview");
        setProjectPendingDeletion(project);
      }}
      onRequestCreateSession={() => {
        void createSession();
      }}
      onRequestCloseSession={(terminalSessionId) => {
        void closeSession(terminalSessionId);
      }}
      onSubmitSessionAlias={updateSessionAlias}
      onOpenHistoryDrawer={openHistoryDrawer}
      onCloseProjectDialog={closeProjectDialog}
      onSubmitProjectDialog={submitProjectDialog}
      onConfirmDeleteProject={() => {
        void removeProject();
      }}
      onProjectDeletionOpenChange={(open) => {
        if (!open && !loading) {
          setProjectPendingDeletion(null);
        }
      }}
      onHistoryDrawerOpenChange={(open) => {
        setHistoryDrawerOpen(open);
        if (!open) {
          setHistoryTerminalSessionId(null);
        }
      }}
      onReorderProjects={handleProjectReorder}
      onReorderSessions={handleSessionReorder}
      onSessionBell={handleSessionBell}
      onSessionMetadata={handleSessionMetadata}
    />
  );
}
