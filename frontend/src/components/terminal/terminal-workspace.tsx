import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TerminalProjectListItem, TerminalSessionListItem } from "@browser-viewer/shared";
import { History, Home, Pencil, Plus, Trash2, X } from "lucide-react";
import type { ConnectionConfig } from "../../features/connection/types";
import {
  loadRecentTerminalSelection,
  saveRecentTerminalSelection,
} from "../../features/terminal/recent-selection";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { resolveCachedTerminalSurfaceIds } from "../../features/terminal/surface-cache";
import { resolveNewTerminalRuntimePreference } from "../../features/terminal/runtime-preference";
import { formatTerminalSessionName } from "../../features/terminal/session-name";
import { HttpError } from "../../services/http";
import {
  createTerminalProject,
  createTerminalSession,
  deleteTerminalProject,
  deleteTerminalSession,
  listTerminalProjects,
  listTerminalSessions,
  updateTerminalProject,
} from "../../services/terminal";
import { Button } from "../ui/button";
import { ConnectionSwitcher } from "../connection-switcher";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { TerminalProjectDialog } from "./terminal-project-dialog";
import { TerminalPreviewMenu } from "./terminal-preview-menu";
import { TerminalHistoryDrawer } from "./terminal-history-drawer";
import { TerminalHeadlessConnection } from "./terminal-headless-connection";
import { TerminalSurface } from "./terminal-surface";
import type { ClientMode } from "../../features/client-mode";

const TerminalPreviewPanel = lazy(() =>
  import("./terminal-preview-panel").then((module) => ({
    default: module.TerminalPreviewPanel,
  })),
);

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

function buildSessionLabel(session: TerminalSessionListItem): string {
  const renderedArgs = session.args.join(" ");
  return renderedArgs ? `${session.command} ${renderedArgs}` : session.command;
}

function resolvePreferredSessionId(
  apiBase: string,
  projectId: string,
  projectSessions: TerminalSessionListItem[],
  preferredSessionId?: string | null,
): string | null {
  if (preferredSessionId) {
    const matchingPreferredSession = projectSessions.find(
      (session) => session.terminalSessionId === preferredSessionId,
    );
    if (matchingPreferredSession) {
      return matchingPreferredSession.terminalSessionId;
    }
  }

  const recentSelection = loadRecentTerminalSelection(apiBase);
  const recentProjectSessionId =
    recentSelection?.projectSessionIds[projectId] ?? recentSelection?.terminalSessionId;
  if (recentProjectSessionId) {
    const matchingRecentSession = projectSessions.find(
      (session) => session.terminalSessionId === recentProjectSessionId,
    );
    if (matchingRecentSession) {
      return matchingRecentSession.terminalSessionId;
    }
  }

  return projectSessions[0]?.terminalSessionId ?? null;
}

function cycleIndex(currentIndex: number, total: number, delta: number): number {
  if (total <= 0) {
    return -1;
  }

  const normalizedCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
  return (normalizedCurrentIndex + delta + total) % total;
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
  const [activityMarkers, setActivityMarkers] = useState<Record<string, boolean>>({});
  const [bellMarkers, setBellMarkers] = useState<Record<string, boolean>>({});
  const [cachedSurfaceSessionIds, setCachedSurfaceSessionIds] = useState<string[]>([]);
  const [projectDialogMode, setProjectDialogMode] = useState<"create" | "edit" | null>(
    null,
  );
  const [projectDialogError, setProjectDialogError] = useState<string | null>(null);
  const [projectPendingDeletion, setProjectPendingDeletion] =
    useState<TerminalProjectListItem | null>(null);
  const [historyTerminalSessionId, setHistoryTerminalSessionId] = useState<string | null>(
    null,
  );
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const loadSessionsRequestIdRef = useRef(0);
  const currentApiBaseRef = useRef(apiBase);
  const isMobileMonitor = clientMode === "mobile";
  const previewOpen = useTerminalPreviewStore((state) => state.ui.open);
  const previewWidthPx = useTerminalPreviewStore((state) => state.ui.widthPx);
  const previewExpanded = useTerminalPreviewStore((state) => state.ui.expanded);
  const previewReservedWidth = previewWidthPx
    ? `${previewWidthPx}px`
    : "clamp(320px, 50vw, 60vw)";
  const terminalLayoutVersion = isMobileMonitor
    ? "mobile"
    : `desktop:${previewOpen ? previewReservedWidth : "full"}`;
  const activeProjectPreviewMode = useTerminalPreviewStore((state) =>
    activeProjectId ? state.projects[activeProjectId]?.mode ?? null : null,
  );
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
    setActivityMarkers({});
    setBellMarkers({});
    setCachedSurfaceSessionIds([]);
  }, [apiBase]);

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
  const sessionIds = useMemo(
    () => sessions.map((session) => session.terminalSessionId),
    [sessions],
  );
  const cachedSurfaceSessionIdSet = useMemo(
    () => new Set(cachedSurfaceSessionIds),
    [cachedSurfaceSessionIds],
  );

  const activeProject =
    visibleProjects.find((project) => project.projectId === activeProjectId) ?? null;
  const activeSession =
    visibleSessions.find((session) => session.terminalSessionId === activeSessionId) ??
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
        const recentProjectId = loadRecentTerminalSelection(apiBase)?.projectId;
        return (
          initialSessionProjectId ??
          recentProjectId ??
          nextProjects[0]?.projectId ??
          null
        );
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
    const recentProjectId = loadRecentTerminalSelection(apiBase)?.projectId;
    const desiredProjectId =
      activeProjectId ?? initialSessionProjectId ?? recentProjectId;

    if (
      desiredProjectId &&
      visibleProjects.some((project) => project.projectId === desiredProjectId)
    ) {
      setActiveProjectId(desiredProjectId);
      return;
    }

    setActiveProjectId(visibleProjects[0]?.projectId ?? null);
  }, [activeProjectId, apiBase, initialTerminalSessionId, sessions, visibleProjects]);

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
    if (!hasLoadedSessions) {
      return;
    }

    if (requestError) {
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

  useEffect(() => {
    if (!hasLoadedSessions || requestError || !activeProjectId) {
      return;
    }

    saveRecentTerminalSelection(apiBase, {
      projectId: activeProjectId,
      terminalSessionId: activeSession?.terminalSessionId ?? null,
    });
  }, [
    activeProjectId,
    activeSession?.terminalSessionId,
    apiBase,
    hasLoadedSessions,
    requestError,
  ]);

  useEffect(() => {
    if (projectDialogMode || projectPendingDeletion) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      const matchesPrevious = event.code === "BracketLeft" || event.key === "[";
      const matchesNext = event.code === "BracketRight" || event.key === "]";
      const isPreviousProject = !event.shiftKey && matchesPrevious;
      const isNextProject = !event.shiftKey && matchesNext;
      const isPreviousSession = event.shiftKey && matchesPrevious;
      const isNextSession = event.shiftKey && matchesNext;

      if (!isPreviousProject && !isNextProject && !isPreviousSession && !isNextSession) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (isPreviousProject || isNextProject) {
        if (visibleProjects.length <= 1) {
          return;
        }

        const currentProjectIndex = visibleProjects.findIndex(
          (project) => project.projectId === activeProjectId,
        );
        const nextProject = visibleProjects[
          cycleIndex(
            currentProjectIndex,
            visibleProjects.length,
            isPreviousProject ? -1 : 1,
          )
        ];
        if (!nextProject) {
          return;
        }
        setActiveProjectId(nextProject.projectId);
        return;
      }

      if (visibleSessions.length <= 1) {
        return;
      }

      const currentSessionIndex = visibleSessions.findIndex(
        (session) => session.terminalSessionId === activeSession?.terminalSessionId,
      );
      const nextSession = visibleSessions[
        cycleIndex(
          currentSessionIndex,
          visibleSessions.length,
          isPreviousSession ? -1 : 1,
        )
      ];
      if (!nextSession) {
        return;
      }
      setActiveSessionId(nextSession.terminalSessionId);
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    activeProjectId,
    activeSession?.terminalSessionId,
    projectDialogMode,
    projectPendingDeletion,
    visibleProjects,
    visibleSessions,
  ]);

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

    setActivityMarkers((current) => {
      if (!current[activeSession.terminalSessionId]) {
        return current;
      }

      return {
        ...current,
        [activeSession.terminalSessionId]: false,
      };
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

  useEffect(() => {
    const sessionIds = new Set(sessions.map((session) => session.terminalSessionId));
    setActivityMarkers((current) => {
      let changed = false;
      const nextEntries = Object.entries(current).filter(([terminalSessionId, active]) => {
        const keep = active && sessionIds.has(terminalSessionId);
        if (!keep) {
          changed = true;
        }
        return keep;
      });

      if (!changed) {
        return current;
      }

      return Object.fromEntries(nextEntries);
    });
  }, [sessions]);

  useEffect(() => {
    if (!historyTerminalSessionId) {
      return;
    }

    if (
      sessions.some(
        (session) => session.terminalSessionId === historyTerminalSessionId,
      )
    ) {
      return;
    }

    setHistoryDrawerOpen(false);
    setHistoryTerminalSessionId(null);
  }, [historyTerminalSessionId, sessions]);

  useEffect(() => {
    const sessionIds = new Set(sessions.map((session) => session.terminalSessionId));
    setBellMarkers((current) => {
      let changed = false;
      const nextEntries = Object.entries(current).filter(([terminalSessionId, active]) => {
        const keep = active && sessionIds.has(terminalSessionId);
        if (!keep) {
          changed = true;
        }
        return keep;
      });

      if (!changed) {
        return current;
      }

      return Object.fromEntries(nextEntries);
    });
  }, [sessions]);

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

  const closeSession = async (terminalSessionId: string): Promise<void> => {
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
  };

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

  const handleSessionActivity = useCallback((terminalSessionId: string) => {
    setActivityMarkers((current) => {
      if (current[terminalSessionId]) {
        return current;
      }

      return {
        ...current,
        [terminalSessionId]: true,
      };
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
    <section
      className={[
        "flex h-full min-h-0 flex-col overflow-hidden bg-slate-950 text-slate-100",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex h-8 items-center gap-1.5 border-b border-slate-800 px-2">
        {onNavigateHome && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Go home"
            title="Go home"
            className="h-6 w-6 shrink-0 rounded-md px-0 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
            onClick={onNavigateHome}
          >
            <Home className="h-3.5 w-3.5" />
          </Button>
        )}
        {connections?.length &&
        activeConnectionId &&
        onSelectConnection &&
        onOpenConnectionManager ? (
          <ConnectionSwitcher
            connections={connections ?? []}
            activeConnectionId={activeConnectionId ?? null}
            activeConnectionName={connectionName}
            onSelectConnection={onSelectConnection}
            onOpenConnectionManager={onOpenConnectionManager}
            className="h-6 shrink-0 rounded-md border border-slate-800 bg-slate-900 px-2 text-[11px] text-slate-300 hover:bg-slate-800 hover:text-slate-100"
          />
        ) : null}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {visibleProjects.map((project) => {
            const isActive = project.projectId === activeProjectId;
            const hasBell = sessions.some(
              (session) =>
                session.projectId === project.projectId &&
                bellMarkers[session.terminalSessionId],
            );
            const hasActivity = sessions.some(
              (session) =>
                session.projectId === project.projectId &&
                activityMarkers[session.terminalSessionId],
            );
            return (
              <ContextMenu key={project.projectId}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    aria-pressed={isActive}
                    className={[
                      "inline-flex h-6 shrink-0 items-center gap-2 rounded-md border px-3 text-xs transition-colors",
                      isActive
                        ? "border-sky-700/70 bg-slate-800 text-slate-50 shadow-[inset_0_1px_0_rgba(148,163,184,0.18)]"
                        : "border-slate-800 bg-slate-900/90 text-slate-200 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                    ].join(" ")}
                    onClick={() => {
                      setActiveProjectId(project.projectId);
                    }}
                    title={project.name}
                  >
                    <span className="max-w-[160px] truncate">{project.name}</span>
                    {hasBell || hasActivity ? (
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          hasBell ? "bg-amber-400" : "bg-emerald-400"
                        }`}
                      />
                    ) : null}
                  </button>
                </ContextMenuTrigger>
                {!isMobileMonitor ? (
                  <ContextMenuContent className="w-44">
                    <ContextMenuItem
                      onSelect={() => {
                        setActiveProjectId(project.projectId);
                        setProjectDialogError(null);
                        setProjectDialogMode("edit");
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                      Edit
                    </ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => {
                        setActiveProjectId(project.projectId);
                        setProjectPendingDeletion(project);
                      }}
                      className="text-rose-400 focus:text-rose-400"
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </ContextMenuItem>
                  </ContextMenuContent>
                ) : null}
              </ContextMenu>
            );
          })}
          {!isMobileMonitor ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={loading}
              aria-label="New Project"
              title="New Project"
              className="h-6 w-8 shrink-0 rounded-md border border-slate-800 bg-slate-900/90 px-0 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100"
              onClick={() => {
                setProjectDialogError(null);
                setProjectDialogMode("create");
              }}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
        {!isMobileMonitor ? (
          <TerminalPreviewMenu
            projectId={activeProjectId}
            mode={activeProjectPreviewMode}
            disabled={loading}
            buttonClassName="h-6 shrink-0 rounded-md px-2 text-xs text-slate-300 hover:bg-slate-800 hover:text-slate-100"
          />
        ) : null}
        {!isMobileMonitor ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!activeSession?.terminalSessionId}
            aria-label="Open terminal history"
            title="Open terminal history"
            className="h-6 w-6 shrink-0 rounded-md px-0 text-slate-300 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40"
            onClick={() => {
              if (activeSession?.terminalSessionId) {
                openHistoryDrawer(activeSession.terminalSessionId);
              }
            }}
          >
            <History className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="flex h-[26px] items-stretch border-b border-slate-800">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {visibleSessions.map((session) => {
            const isActive =
              session.terminalSessionId === activeSession?.terminalSessionId;
            const hasBell = !isActive && bellMarkers[session.terminalSessionId];
            const hasActivity = !isActive && activityMarkers[session.terminalSessionId];
            const displayName = formatTerminalSessionName({
              cwd: session.cwd,
              activeCommand: session.activeCommand,
            });
            return (
              <div
                key={session.terminalSessionId}
                className={[
                  "relative flex h-full shrink-0 items-center gap-2 border-r border-slate-800 pl-2 pr-3",
                  isActive
                    ? "overflow-hidden bg-slate-900/35 text-slate-50 before:absolute before:inset-x-0 before:bottom-0 before:h-0.5 before:bg-sky-500"
                    : "text-slate-300 hover:bg-slate-900/45 hover:text-slate-100",
                ].join(" ")}
              >
                <button
                  type="button"
                  aria-label={displayName}
                  data-terminal-session-id={session.terminalSessionId}
                  className={[
                    "inline-flex h-full max-w-[220px] items-center gap-1.5 py-0 text-xs",
                    isActive ? "text-slate-50" : "text-slate-200",
                  ].join(" ")}
                  onClick={() => {
                    setActiveSessionId(session.terminalSessionId);
                  }}
                  title={buildSessionLabel(session)}
                >
                  <span className="truncate">{displayName}</span>
                  {hasBell || hasActivity ? (
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        hasBell ? "bg-amber-400" : "bg-emerald-400"
                      }`}
                    />
                  ) : null}
                </button>
                {!isMobileMonitor ? (
                  <button
                    type="button"
                    className={[
                      "flex h-4 w-4 items-center justify-center rounded-sm transition-colors",
                      isActive
                        ? "text-slate-400 hover:text-slate-100"
                        : "text-slate-500 hover:text-slate-200",
                    ].join(" ")}
                    aria-label={`Close terminal ${displayName}`}
                    onClick={() => {
                      void closeSession(session.terminalSessionId);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
            );
          })}
          {!isMobileMonitor ? (
            <button
              type="button"
              disabled={loading}
              className="flex h-full w-10 shrink-0 items-center justify-center border-r border-slate-800 text-slate-300 hover:bg-slate-900/45 hover:text-slate-100 disabled:opacity-40"
              aria-label="New Terminal"
              title="New Terminal"
              onClick={() => {
                void createSession();
              }}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {requestError ? (
          <p className="border-b border-rose-900/60 bg-rose-950/30 px-3 py-1.5 text-xs text-rose-300">
            {requestError}
          </p>
        ) : null}
        <div className="relative flex h-full min-h-0">
          <div className="relative min-h-0 flex-1">
            {sessions.length > 0 ? (
              sessions.map((session) => {
                const isActive =
                  session.terminalSessionId === activeSession?.terminalSessionId;
                const shouldRenderSurface =
                  isActive || cachedSurfaceSessionIdSet.has(session.terminalSessionId);

                if (!shouldRenderSurface) {
                  return (
                    <TerminalHeadlessConnection
                      apiBase={apiBase}
                      key={`${apiBase}:${session.terminalSessionId}:headless`}
                      terminalSessionId={session.terminalSessionId}
                      token={token}
                      onAuthExpired={onAuthExpired}
                      onActivity={() => {
                        handleSessionActivity(session.terminalSessionId);
                      }}
                      onBell={() => {
                        handleSessionBell(session.terminalSessionId);
                      }}
                      onMetadata={(metadata) => {
                        handleSessionMetadata(session.terminalSessionId, metadata);
                      }}
                    />
                  );
                }

                return (
                  <div
                    aria-hidden={!isActive}
                    className={[
                      "absolute top-0 h-full w-full",
                      isActive ? "left-0" : "-left-[9999em] pointer-events-none",
                    ].join(" ")}
                    key={`${apiBase}:${session.terminalSessionId}:surface`}
                  >
                    <TerminalSurface
                      active={isActive}
                      apiBase={apiBase}
                      clientMode={clientMode}
                      layoutVersion={terminalLayoutVersion}
                      terminalSessionId={session.terminalSessionId}
                      token={token}
                      onAuthExpired={onAuthExpired}
                      onActivity={() => {
                        handleSessionActivity(session.terminalSessionId);
                      }}
                      onBell={() => {
                        handleSessionBell(session.terminalSessionId);
                      }}
                      onMetadata={(metadata) => {
                        handleSessionMetadata(session.terminalSessionId, metadata);
                      }}
                      onOpenHistory={() => {
                        openHistoryDrawer(session.terminalSessionId);
                      }}
                    />
                  </div>
                );
              })
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-sm text-slate-400">
                No terminal tab yet. Create one to start.
              </div>
            )}
          </div>
          {previewOpen && !previewExpanded && !isMobileMonitor ? (
            <Suspense
              fallback={
                <aside className="flex h-full w-[min(40vw,520px)] shrink-0 items-center justify-center border-l border-slate-800 bg-slate-950 text-sm text-slate-400">
                  Loading preview...
                </aside>
              }
            >
              <TerminalPreviewPanel
                apiBase={apiBase}
                token={token}
                activeProject={activeProject}
                widthPx={previewWidthPx}
                onAuthExpired={onAuthExpired}
                onEditProject={() => {
                  setProjectDialogError(null);
                  setProjectDialogMode("edit");
                }}
              />
            </Suspense>
          ) : null}
          {previewOpen && previewExpanded && !isMobileMonitor ? (
            <>
              <div
                aria-hidden="true"
                className="min-h-0 shrink-0"
                style={{ width: previewReservedWidth }}
              />
              <div className="absolute inset-0 z-20">
                <Suspense
                  fallback={
                    <aside className="flex h-full w-full items-center justify-center bg-slate-950 text-sm text-slate-400">
                      Loading preview...
                    </aside>
                  }
                >
                  <TerminalPreviewPanel
                    apiBase={apiBase}
                    token={token}
                    activeProject={activeProject}
                    widthPx={previewWidthPx}
                    onAuthExpired={onAuthExpired}
                    onEditProject={() => {
                      setProjectDialogError(null);
                      setProjectDialogMode("edit");
                    }}
                  />
                </Suspense>
              </div>
            </>
          ) : null}
        </div>
      </div>
      <TerminalProjectDialog
        open={projectDialogMode !== null}
        mode={projectDialogMode ?? "create"}
        loading={loading}
        error={projectDialogError}
        initialName={projectDialogMode === "edit" ? activeProject?.name ?? "" : ""}
        initialPath={projectDialogMode === "edit" ? activeProject?.path ?? "" : ""}
        onClose={closeProjectDialog}
        onSubmit={submitProjectDialog}
      />
      <TerminalHistoryDrawer
        open={historyDrawerOpen}
        apiBase={apiBase}
        token={token}
        terminalSessionId={historyTerminalSessionId}
        terminalName={historyTerminalName}
        onOpenChange={(open) => {
          setHistoryDrawerOpen(open);
          if (!open) {
            setHistoryTerminalSessionId(null);
          }
        }}
        onAuthExpired={onAuthExpired}
      />
      <AlertDialog
        open={projectPendingDeletion !== null}
        onOpenChange={(open) => {
          if (!open && !loading) {
            setProjectPendingDeletion(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Project</AlertDialogTitle>
            <AlertDialogDescription>
              Delete "{projectPendingDeletion?.name}" and all terminal tabs inside it.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={loading}
              className="bg-rose-500 text-white hover:bg-rose-500/90 hover:shadow-[0_22px_50px_-24px_rgba(244,63,94,0.82)]"
              onClick={(event) => {
                event.preventDefault();
                void removeProject();
              }}
            >
              {loading ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
