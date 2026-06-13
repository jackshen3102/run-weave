import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  TerminalEventEnvelope,
  TerminalProjectListItem,
  TerminalSessionListItem,
  TerminalState,
} from "@runweave/shared";
import type { ConnectionConfig } from "../../features/connection/types";
import { createTerminalBellPlayer } from "../../features/terminal/bell";
import {
  DEFAULT_TERMINAL_SIDECAR_WIDTH,
  useTerminalPreviewStore,
} from "../../features/terminal/preview-store";
import { resolveCachedTerminalSurfaceIds } from "../../features/terminal/surface-cache";
import { resolveNewTerminalRuntimePreference } from "../../features/terminal/runtime-preference";
import { formatTerminalSessionName } from "../../features/terminal/session-name";
import { useTerminalEventsConnection } from "../../features/terminal/use-terminal-events-connection";
import type { ClientMode } from "../../features/client-mode";
import { HttpError } from "../../services/http";
import {
  createTerminalProject,
  createTerminalSession,
  deleteTerminalProject,
  deleteTerminalSession,
  listTerminalProjects,
  listTerminalSessions,
  reorderTerminalProjects,
  reorderTerminalSessions,
  updateTerminalProject,
} from "../../services/terminal";
import {
  resolvePreferredSessionId,
  usePersistRecentSelection,
  useSessionMarkerCleanup,
  useSessionSelectionShortcuts,
} from "./terminal-workspace-effects";
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
const BELL_MARKER_DURATION_MS = 2_000;

function isTerminalListInvalidationEvent(event: TerminalEventEnvelope): boolean {
  return (
    event.kind === "project_created" ||
    event.kind === "project_deleted" ||
    event.kind === "terminal_session_created" ||
    event.kind === "terminal_session_deleted"
  );
}

function getLatestCreatedSessionEvent(
  events: TerminalEventEnvelope[],
): Extract<TerminalEventEnvelope, { kind: "terminal_session_created" }> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "terminal_session_created") {
      return event;
    }
  }
  return null;
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
  const terminalEventCursorRef = useRef<string | null>(null);
  const completionBellPlayerRef = useRef<ReturnType<
    typeof createTerminalBellPlayer
  > | null>(null);
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
    terminalEventCursorRef.current = null;
  }, [apiBase]);

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

  const applyTerminalEvents = useCallback(
    (events: TerminalEventEnvelope[], delivery: "catchup" | "live"): void => {
      const latestEvent = events[events.length - 1];
      if (latestEvent) {
        terminalEventCursorRef.current = latestEvent.id;
      }

      const stateEvents = events.filter(
        (event) => event.kind === "terminal_state_changed",
      );
      if (stateEvents.length > 0) {
        setTerminalStateBySessionId((current) => {
          let changed = false;
          const next = { ...current };
          for (const event of stateEvents) {
            if (event.kind !== "terminal_state_changed") {
              continue;
            }
            const terminalState = event.payload.next;
            const currentState = next[event.terminalSessionId];
            if (
              currentState?.state === terminalState.state &&
              currentState.agent === terminalState.agent
            ) {
              continue;
            }
            next[event.terminalSessionId] = terminalState;
            changed = true;
          }
          return changed ? next : current;
        });
      }

      if (events.some(isTerminalListInvalidationEvent)) {
        const latestCreatedSession = getLatestCreatedSessionEvent(events);
        void loadSessions().then(() => {
          if (!latestCreatedSession || activeSessionIdRef.current) {
            return;
          }
          setActiveProjectId(latestCreatedSession.projectId);
          selectActiveSession(latestCreatedSession.terminalSessionId);
        });
      }

      const knownSessionIds = new Set(
        sessionsRef.current.map((session) => session.terminalSessionId),
      );
      const markerSessionIds = events
        .filter((event) => event.kind === "completion")
        .map((event) => event.terminalSessionId)
        .filter(
          (terminalSessionId) =>
            terminalSessionId !== activeSessionIdRef.current &&
            knownSessionIds.has(terminalSessionId),
        );
      if (markerSessionIds.length === 0) {
        return;
      }

      setCompletionMarkers((current) => {
        let changed = false;
        const next = { ...current };
        for (const terminalSessionId of markerSessionIds) {
          if (!next[terminalSessionId]) {
            next[terminalSessionId] = true;
            changed = true;
          }
        }
        return changed ? next : current;
      });

      if (delivery === "live" && window.electronAPI?.isElectron === true) {
        completionBellPlayerRef.current ??= createTerminalBellPlayer();
        void completionBellPlayerRef.current.play();
      }
    },
    [loadSessions, selectActiveSession],
  );

  const getCompletionEventCursor = useCallback(
    () => terminalEventCursorRef.current,
    [],
  );
  const setCompletionEventCursor = useCallback((cursor: string) => {
    terminalEventCursorRef.current = cursor;
  }, []);
  useTerminalEventsConnection({
    apiBase,
    token,
    getCursor: getCompletionEventCursor,
    setCursor: setCompletionEventCursor,
    onAuthExpired,
    onTerminalEvents: applyTerminalEvents,
  });
  const createSession = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const created = await createTerminalSession(apiBase, token, {
        projectId: activeProjectId ?? undefined,
        inheritFromTerminalSessionId: activeSession?.terminalSessionId,
        runtimePreference: resolveNewTerminalRuntimePreference(clientMode),
      });
      setRequestError(null);
      await loadSessions();
      setActiveSessionId(created.terminalSessionId);
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        onAuthExpired?.();
        return;
      }
      setRequestError(String(error));
    } finally {
      setLoading(false);
    }
  }, [
    activeProjectId,
    activeSession?.terminalSessionId,
    apiBase,
    clientMode,
    loadSessions,
    onAuthExpired,
    token,
  ]);
  const closeSession = useCallback(
    async (terminalSessionId: string): Promise<void> => {
      setLoading(true);
      try {
        await deleteTerminalSession(apiBase, token, terminalSessionId);
        setRequestError(null);
        await loadSessions();
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) {
          onAuthExpired?.();
          return;
        }
        setRequestError(String(error));
      } finally {
        setLoading(false);
      }
    },
    [apiBase, loadSessions, onAuthExpired, token],
  );
  const closeProjectDialog = useCallback(() => {
    if (loading) {
      return;
    }
    setProjectDialogError(null);
    setProjectDialogMode(null);
  }, [loading]);
  const submitProjectDialog = useCallback(
    async (name: string, projectPath: string): Promise<void> => {
      const trimmedName = name.trim();
      if (!trimmedName) {
        setProjectDialogError("Project name is required.");
        return;
      }
      const trimmedPath = projectPath.trim();
      setLoading(true);
      setProjectDialogError(null);
      try {
        if (projectDialogMode === "edit" && activeProject) {
          const updatedProject = await updateTerminalProject(
            apiBase,
            token,
            activeProject.projectId,
            { name: trimmedName, path: trimmedPath || null },
          );
          setProjects((currentProjects) =>
            currentProjects.map((project) =>
              project.projectId === updatedProject.projectId
                ? updatedProject
                : project,
            ),
          );
        } else {
          const createdProject = await createTerminalProject(apiBase, token, {
            name: trimmedName,
            path: trimmedPath || null,
          });
          const createdSession = await createTerminalSession(apiBase, token, {
            projectId: createdProject.projectId,
            runtimePreference: resolveNewTerminalRuntimePreference(clientMode),
          });
          setProjects((currentProjects) => [
            ...currentProjects,
            createdProject,
          ]);
          setActiveProjectId(createdProject.projectId);
          selectActiveSession(createdSession.terminalSessionId);
          const createdAt = new Date().toISOString();
          setSessions((currentSessions) => [
            ...currentSessions,
            {
              terminalSessionId: createdSession.terminalSessionId,
              projectId: createdProject.projectId,
              command: "",
              args: [],
              cwd: "",
              activeCommand: null,
              status: "running",
              createdAt,
              lastActivityAt: createdAt,
            },
          ]);
          await loadSessions();
        }
        setProjectDialogMode(null);
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) {
          onAuthExpired?.();
          return;
        }
        setProjectDialogError(String(error));
      } finally {
        setLoading(false);
      }
    },
    [
      activeProject,
      apiBase,
      clientMode,
      loadSessions,
      onAuthExpired,
      projectDialogMode,
      selectActiveSession,
      token,
    ],
  );
  const removeProject = useCallback(async (): Promise<void> => {
    const targetProject = projectPendingDeletion ?? activeProject;
    if (!targetProject) {
      return;
    }
    setLoading(true);
    try {
      await deleteTerminalProject(apiBase, token, targetProject.projectId);
      setRequestError(null);
      setProjectDialogError(null);
      setActiveSessionId(null);
      setActiveProjectId(null);
      removeProjectPreview(targetProject.projectId);
      setProjectPendingDeletion(null);
      await loadSessions();
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        onAuthExpired?.();
        return;
      }
      setRequestError(String(error));
    } finally {
      setLoading(false);
    }
  }, [
    activeProject,
    apiBase,
    loadSessions,
    onAuthExpired,
    projectPendingDeletion,
    removeProjectPreview,
    token,
  ]);
  const handleSessionMetadata = useCallback(
    (
      terminalSessionId: string,
      metadata: { cwd: string; activeCommand: string | null },
    ) => {
      setSessions((currentSessions) => {
        let changed = false;
        const nextSessions = currentSessions.map((session) => {
          if (session.terminalSessionId !== terminalSessionId) {
            return session;
          }
          if (
            session.cwd === metadata.cwd &&
            session.activeCommand === metadata.activeCommand
          ) {
            return session;
          }
          changed = true;
          return {
            ...session,
            cwd: metadata.cwd,
            activeCommand: metadata.activeCommand,
          };
        });
        return changed ? nextSessions : currentSessions;
      });
    },
    [],
  );
  const handleSessionBell = useCallback((terminalSessionId: string) => {
    setBellMarkers((current) => ({
      ...current,
      [terminalSessionId]: true,
    }));
    window.setTimeout(() => {
      setBellMarkers((current) => {
        if (!current[terminalSessionId]) {
          return current;
        }
        const next = { ...current };
        delete next[terminalSessionId];
        return next;
      });
    }, BELL_MARKER_DURATION_MS);
  }, []);
  const handleProjectReorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      setProjects((current) => {
        const reordered = [...current];
        const [moved] = reordered.splice(fromIndex, 1);
        if (moved) {
          reordered.splice(toIndex, 0, moved);
        }
        const orderedIds = reordered.map((p) => p.projectId);
        void reorderTerminalProjects(apiBase, token, orderedIds).catch(() => {
          void loadSessions();
        });
        return reordered;
      });
    },
    [apiBase, loadSessions, token],
  );

  const handleSessionReorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (!activeProjectId) {
        return;
      }
      setSessions((current) => {
        const projectSessions = current.filter(
          (s) => s.projectId === activeProjectId,
        );
        const reordered = [...projectSessions];
        const [moved] = reordered.splice(fromIndex, 1);
        if (moved) {
          reordered.splice(toIndex, 0, moved);
        }
        const orderedIds = reordered.map((s) => s.terminalSessionId);
        void reorderTerminalSessions(
          apiBase,
          token,
          activeProjectId,
          orderedIds,
        ).catch(() => {
          void loadSessions();
        });
        let ri = 0;
        return current.map((s) =>
          s.projectId === activeProjectId ? reordered[ri++]! : s,
        );
      });
    },
    [activeProjectId, apiBase, loadSessions, token],
  );

  const openHistoryDrawer = useCallback((terminalSessionId: string) => {
    setHistoryTerminalSessionId(terminalSessionId);
    setHistoryDrawerOpen(true);
  }, []);
  const historySession =
    sessions.find(
      (session) => session.terminalSessionId === historyTerminalSessionId,
    ) ?? null;
  const historyTerminalName = historySession
    ? formatTerminalSessionName({
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
