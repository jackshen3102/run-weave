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
  const [projectDialogMode, setProjectDialogMode] = useState<"create" | "rename" | null>(
    null,
  );
  const [projectDialogError, setProjectDialogError] = useState<string | null>(null);
  const [projectPendingDeletion, setProjectPendingDeletion] =
    useState<TerminalProjectListItem | null>(null);

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
    if (!hasLoadedSessions || requestError || sessions.length > 0) {
      return;
    }

    onNoSessionAvailable?.();
  }, [hasLoadedSessions, onNoSessionAvailable, requestError, sessions.length]);

  const createSession = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const created = await createTerminalSession(apiBase, token, {
        projectId: activeProjectId ?? undefined,
        cwd: activeSession?.cwd,
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
  }, [activeProjectId, activeSession?.cwd, apiBase, loadSessions, onAuthExpired, token]);

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
    [activeProject, apiBase, onAuthExpired, projectDialogMode, token],
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
                      {project.name}
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
                    {session.name}
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

      <div className="min-h-0 flex-1">
        {activeSession ? (
          <TerminalSurface
            key={activeSession.terminalSessionId}
            apiBase={apiBase}
            terminalSessionId={activeSession.terminalSessionId}
            token={token}
            onAuthExpired={onAuthExpired}
            onMetadata={(metadata) => {
              handleSessionMetadata(activeSession.terminalSessionId, metadata);
            }}
          />
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
