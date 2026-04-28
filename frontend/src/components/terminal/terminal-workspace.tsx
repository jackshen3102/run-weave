import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TerminalProjectListItem, TerminalSessionListItem } from "@browser-viewer/shared";
import type { ConnectionConfig } from "../../features/connection/types";
import { DEFAULT_TERMINAL_SIDECAR_WIDTH, useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { resolveCachedTerminalSurfaceIds } from "../../features/terminal/surface-cache";
import { resolveNewTerminalRuntimePreference } from "../../features/terminal/runtime-preference";
import { formatTerminalSessionName } from "../../features/terminal/session-name";
import type { ClientMode } from "../../features/client-mode";
import { HttpError } from "../../services/http";
import { createTerminalProject, createTerminalSession, deleteTerminalProject, deleteTerminalSession, listTerminalCompletionEvents, listTerminalProjects, listTerminalSessions, updateTerminalProject } from "../../services/terminal";
import { resolvePreferredSessionId, usePersistRecentSelection, useSessionMarkerCleanup, useSessionSelectionShortcuts } from "./terminal-workspace-effects";
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
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialTerminalSessionId ?? null);
  const [hasLoadedSessions, setHasLoadedSessions] = useState(false);
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [completionMarkers, setCompletionMarkers] = useState<Record<string, boolean>>({});
  const [bellMarkers, setBellMarkers] = useState<Record<string, boolean>>({});
  const [cachedSurfaceSessionIds, setCachedSurfaceSessionIds] = useState<string[]>([]);
  const [projectDialogMode, setProjectDialogMode] = useState<"create" | "edit" | null>(null);
  const [projectDialogError, setProjectDialogError] = useState<string | null>(null);
  const [projectPendingDeletion, setProjectPendingDeletion] = useState<TerminalProjectListItem | null>(null);
  const [historyTerminalSessionId, setHistoryTerminalSessionId] = useState<string | null>(null);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const loadSessionsRequestIdRef = useRef(0);
  const currentApiBaseRef = useRef(apiBase);
  const activeSessionIdRef = useRef(activeSessionId);
  const completionEventCursorRef = useRef<string | null>(null);
  const isMobileMonitor = clientMode === "mobile";
  const previewOpen = useTerminalPreviewStore((state) => state.ui.open);
  const previewWidthPx = useTerminalPreviewStore((state) => state.ui.widthPx);
  const previewExpanded = useTerminalPreviewStore((state) => state.ui.expanded);
  const previewReservedWidth = previewWidthPx
    ? `${previewWidthPx}px`
    : DEFAULT_TERMINAL_SIDECAR_WIDTH;
  const terminalLayoutVersion = isMobileMonitor
    ? "mobile"
    : `desktop:${previewOpen ? previewReservedWidth : "full"}`;
  const removeProjectPreview = useTerminalPreviewStore((state) => state.removeProjectPreview);
  useEffect(() => {
    loadSessionsRequestIdRef.current += 1;
    currentApiBaseRef.current = apiBase;
    setProjects([]);
    setSessions([]);
    setActiveProjectId(null);
    setActiveSessionId(null);
    setHasLoadedSessions(false);
    setRequestError(null);
    setCompletionMarkers({});
    setBellMarkers({});
    setCachedSurfaceSessionIds([]);
    completionEventCursorRef.current = null;
  }, [apiBase]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);
  const visibleProjects = useMemo(() => {
    return [...projects].sort((left, right) => {
      return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    });
  }, [projects]);
  const visibleSessions = useMemo(() => {
    return sessions
      .filter((session) =>
        activeProjectId ? session.projectId === activeProjectId : true,
      )
      .sort((left, right) => {
        return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
      });
  }, [activeProjectId, sessions]);
  const sessionIds = useMemo(() => sessions.map((session) => session.terminalSessionId), [sessions]);
  const cachedSurfaceSessionIdSet = useMemo(() => new Set(cachedSurfaceSessionIds), [cachedSurfaceSessionIds]);
  const activeProject = visibleProjects.find((project) => project.projectId === activeProjectId) ?? null;
  const activeSession = visibleSessions.find((session) => session.terminalSessionId === activeSessionId) ?? visibleSessions[0] ?? null;
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
      setActiveSessionId(null);
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
    setActiveSessionId(
      resolvePreferredSessionId(
        apiBase,
        activeProjectId ?? visibleSessions[0]!.projectId,
        visibleSessions,
      ),
    );
  }, [activeProjectId, activeSessionId, apiBase, hasLoadedSessions, visibleSessions]);
  useEffect(() => {
    if (!hasLoadedSessions || requestError) {
      return;
    }
    if (activeSession?.terminalSessionId) {
      onActiveSessionChange?.(activeSession.terminalSessionId);
    }
  }, [activeSession?.terminalSessionId, hasLoadedSessions, onActiveSessionChange, requestError]);
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
    onSelectProject: setActiveProjectId,
    onSelectSession: setActiveSessionId,
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
    let disposed = false;
    let stopped = false;

    const pollCompletionEvents = async (): Promise<void> => {
      if (disposed || stopped) {
        return;
      }

      try {
        const response = await listTerminalCompletionEvents(
          apiBase,
          token,
          completionEventCursorRef.current,
        );
        if (disposed) {
          return;
        }

        if (response.events.length > 0) {
          completionEventCursorRef.current =
            response.events[response.events.length - 1]?.id ??
            completionEventCursorRef.current;
        }

        setCompletionMarkers((current) => {
          let changed = false;
          const next = { ...current };
          for (const event of response.events) {
            if (event.terminalSessionId === activeSessionIdRef.current) {
              continue;
            }
            if (!next[event.terminalSessionId]) {
              next[event.terminalSessionId] = true;
              changed = true;
            }
          }
          return changed ? next : current;
        });
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) {
          stopped = true;
          window.clearInterval(intervalId);
          onAuthExpired?.();
        }
      }
    };

    const intervalId = window.setInterval(() => {
      void pollCompletionEvents();
    }, 2_000);
    void pollCompletionEvents();

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [apiBase, onAuthExpired, token]);
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
  const closeSession = useCallback(async (terminalSessionId: string): Promise<void> => {
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
  }, [apiBase, loadSessions, onAuthExpired, token]);
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
              project.projectId === updatedProject.projectId ? updatedProject : project,
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
          setProjects((currentProjects) => [...currentProjects, createdProject]);
          setActiveProjectId(createdProject.projectId);
          setActiveSessionId(createdSession.terminalSessionId);
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
              createdAt: new Date().toISOString(),
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
  }, [activeProject, apiBase, loadSessions, onAuthExpired, projectPendingDeletion, removeProjectPreview, token]);
  const handleSessionMetadata = useCallback((terminalSessionId: string, metadata: { cwd: string; activeCommand: string | null }) => {
    setSessions((currentSessions) => {
      let changed = false;
      const nextSessions = currentSessions.map((session) => {
        if (session.terminalSessionId !== terminalSessionId) {
          return session;
        }
        if (session.cwd === metadata.cwd && session.activeCommand === metadata.activeCommand) {
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
  }, []);
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
      terminalLayoutVersion={terminalLayoutVersion}
      onSelectProject={setActiveProjectId}
      onSelectSession={setActiveSessionId}
      onRequestCreateProject={() => {
        setProjectDialogError(null);
        setProjectDialogMode("create");
      }}
      onRequestEditProject={(projectId) => {
        if (projectId) {
          setActiveProjectId(projectId);
        }
        setProjectDialogError(null);
        setProjectDialogMode("edit");
      }}
      onRequestDeleteProject={(project) => {
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
      onSessionBell={handleSessionBell}
      onSessionMetadata={handleSessionMetadata}
    />
  );
}
