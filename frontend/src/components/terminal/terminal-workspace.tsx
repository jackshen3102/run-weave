import { useCallback, useEffect, useMemo, useState } from "react";
import type { TerminalProjectListItem, TerminalSessionListItem } from "@browser-viewer/shared";
import { Home, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  loadRecentTerminalSelection,
  saveRecentTerminalSelection,
} from "../../features/terminal/recent-selection";
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
import { TerminalHistoryDrawer } from "./terminal-history-drawer";
import { TerminalSurface } from "./terminal-surface";

interface TerminalWorkspaceProps {
  apiBase: string;
  token: string;
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
  const [projectDialogMode, setProjectDialogMode] = useState<"create" | "rename" | null>(
    null,
  );
  const [projectDialogError, setProjectDialogError] = useState<string | null>(null);
  const [projectPendingDeletion, setProjectPendingDeletion] =
    useState<TerminalProjectListItem | null>(null);
  const [historyTerminalSessionId, setHistoryTerminalSessionId] = useState<string | null>(
    null,
  );
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);

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

  const activeProject =
    visibleProjects.find((project) => project.projectId === activeProjectId) ?? null;
  const activeSession =
    visibleSessions.find((session) => session.terminalSessionId === activeSessionId) ??
    visibleSessions[0] ??
    null;

  const loadSessions = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [nextProjects, nextSessions] = await Promise.all([
        listTerminalProjects(apiBase, token),
        listTerminalSessions(apiBase, token),
      ]);
      setProjects(nextProjects);
      setSessions(nextSessions);
      setActiveProjectId((currentProjectId) => {
        if (currentProjectId) {
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
      if (error instanceof HttpError && error.status === 401) {
        onAuthExpired?.();
        return;
      }
      setRequestError(String(error));
    } finally {
      setHasLoadedSessions(true);
      setLoading(false);
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
    async (name: string): Promise<void> => {
      const trimmedName = name.trim();
      if (!trimmedName) {
        setProjectDialogError("Project name is required.");
        return;
      }

      setLoading(true);
      setProjectDialogError(null);
      try {
        if (projectDialogMode === "rename" && activeProject) {
          const updatedProject = await updateTerminalProject(
            apiBase,
            token,
            activeProject.projectId,
            { name: trimmedName },
          );
          setProjects((currentProjects) =>
            currentProjects.map((project) =>
              project.projectId === updatedProject.projectId ? updatedProject : project,
            ),
          );
        } else {
          const createdProject = await createTerminalProject(apiBase, token, {
            name: trimmedName,
          });
          const createdSession = await createTerminalSession(apiBase, token, {
            projectId: createdProject.projectId,
          });
          setProjects((currentProjects) => [...currentProjects, createdProject]);
          setActiveProjectId(createdProject.projectId);
          setActiveSessionId(createdSession.terminalSessionId);
          setSessions((currentSessions) => [
            ...currentSessions,
            {
              terminalSessionId: createdSession.terminalSessionId,
              projectId: createdProject.projectId,
              name: trimmedName,
              command: "",
              args: [],
              cwd: "",
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
    [activeProject, apiBase, loadSessions, onAuthExpired, projectDialogMode, token],
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
  }, [activeProject, apiBase, loadSessions, onAuthExpired, projectPendingDeletion, token]);

  const handleSessionMetadata = useCallback(
    (terminalSessionId: string, metadata: { name: string; cwd: string }) => {
      setSessions((currentSessions) =>
        currentSessions.map((session) =>
          session.terminalSessionId === terminalSessionId
            ? { ...session, name: metadata.name, cwd: metadata.cwd }
            : session,
        ),
      );
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

  return (
    <section
      className={[
        "flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-800/90 bg-slate-950",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="border-b border-slate-800/90 px-3 py-2">
        <div className="mb-2 flex items-center gap-2">
          {onNavigateHome && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Go home"
              className="h-9 shrink-0 rounded-full px-3"
              onClick={onNavigateHome}
            >
              <Home className="h-4 w-4" />
            </Button>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
                      className={`shrink-0 rounded-full border px-3 py-1 text-xs ${
                        isActive
                          ? "border-slate-100 bg-slate-100 text-slate-900"
                          : "border-slate-700/80 text-slate-300"
                      }`}
                      onClick={() => {
                        setActiveProjectId(project.projectId);
                      }}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <span>{project.name}</span>
                        {!isActive && (hasBell || hasActivity) ? (
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              hasBell ? "bg-amber-400" : "bg-emerald-400"
                            }`}
                          />
                        ) : null}
                      </span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-44">
                    <ContextMenuItem
                      onSelect={() => {
                        setActiveProjectId(project.projectId);
                        setProjectDialogError(null);
                        setProjectDialogMode("rename");
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                      Rename
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
                </ContextMenu>
              );
            })}
          </div>
          <Button
            type="button"
            size="sm"
            disabled={loading}
            className="h-9 shrink-0 rounded-full px-4"
            onClick={() => {
              setProjectDialogError(null);
              setProjectDialogMode("create");
            }}
          >
            <Plus className="mr-1 h-4 w-4" />
            New Project
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {visibleSessions.map((session) => {
              const isActive =
                session.terminalSessionId === activeSession?.terminalSessionId;
              const hasBell = !isActive && bellMarkers[session.terminalSessionId];
              const hasActivity = !isActive && activityMarkers[session.terminalSessionId];
              return (
                <div
                  key={session.terminalSessionId}
                  className="flex items-center gap-1 rounded-full border border-slate-700/80 bg-slate-900/60 px-2 py-1"
                >
                  <button
                    type="button"
                    className={`max-w-[220px] truncate rounded-full px-2 py-0.5 text-xs ${
                      isActive ? "bg-slate-100 text-slate-900" : "text-slate-300"
                    }`}
                    onClick={() => {
                      setActiveSessionId(session.terminalSessionId);
                    }}
                    title={buildSessionLabel(session)}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <span>{session.name}</span>
                      {hasBell || hasActivity ? (
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            hasBell ? "bg-amber-400" : "bg-emerald-400"
                          }`}
                        />
                      ) : null}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="rounded-full p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                    aria-label={`Close terminal ${session.name}`}
                    onClick={() => {
                      void closeSession(session.terminalSessionId);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="hidden shrink-0 text-[11px] text-slate-500 xl:block">
            Project Alt+[ / Alt+]  Tab Alt+Shift+[ / Alt+Shift+]
          </div>
          <Button
            type="button"
            size="sm"
            disabled={loading}
            className="h-9 shrink-0 rounded-full px-4"
            onClick={() => {
              void createSession();
            }}
          >
            <Plus className="mr-1 h-4 w-4" />
            New Terminal
          </Button>
        </div>

        {requestError ? (
          <p className="mt-2 text-xs text-rose-400">{requestError}</p>
        ) : null}
      </div>

      <div className="relative min-h-0 flex-1">
        {sessions.length > 0 ? (
          sessions.map((session) => {
            const isActive =
              session.terminalSessionId === activeSession?.terminalSessionId;

            return (
              <div
                aria-hidden={!isActive}
                className={[
                  "absolute top-0 h-full w-full",
                  isActive ? "left-0" : "-left-[9999em] pointer-events-none",
                ].join(" ")}
                key={session.terminalSessionId}
              >
                <TerminalSurface
                  active={isActive}
                  apiBase={apiBase}
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
      <TerminalProjectDialog
        open={projectDialogMode !== null}
        mode={projectDialogMode ?? "create"}
        loading={loading}
        error={projectDialogError}
        initialName={projectDialogMode === "rename" ? activeProject?.name ?? "" : ""}
        onClose={closeProjectDialog}
        onSubmit={submitProjectDialog}
      />
      <TerminalHistoryDrawer
        open={historyDrawerOpen}
        apiBase={apiBase}
        token={token}
        terminalSessionId={historyTerminalSessionId}
        terminalName={historySession?.name}
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
