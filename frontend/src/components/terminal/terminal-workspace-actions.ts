import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  TerminalProjectListItem,
  TerminalSessionListItem,
} from "@runweave/shared";
import { resolveNewTerminalRuntimePreference } from "../../features/terminal/runtime-preference";
import type { ClientMode } from "../../features/client-mode";
import { HttpError } from "../../services/http";
import {
  createTerminalProject,
  createTerminalSession,
  deleteTerminalProject,
  deleteTerminalSession,
  reorderTerminalProjects,
  reorderTerminalSessions,
  updateTerminalSession,
  updateTerminalProject,
} from "../../services/terminal";

const BELL_MARKER_DURATION_MS = 2_000;

interface UseTerminalWorkspaceActionsArgs {
  apiBase: string;
  token: string;
  clientMode: ClientMode;
  loading: boolean;
  activeProjectId: string | null;
  activeProject: TerminalProjectListItem | null;
  activeSession: TerminalSessionListItem | null;
  projectDialogMode: "create" | "edit" | null;
  projectPendingDeletion: TerminalProjectListItem | null;
  setProjects: Dispatch<SetStateAction<TerminalProjectListItem[]>>;
  setSessions: Dispatch<SetStateAction<TerminalSessionListItem[]>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setRequestError: Dispatch<SetStateAction<string | null>>;
  setProjectDialogMode: Dispatch<SetStateAction<"create" | "edit" | null>>;
  setProjectDialogError: Dispatch<SetStateAction<string | null>>;
  setProjectPendingDeletion: Dispatch<
    SetStateAction<TerminalProjectListItem | null>
  >;
  setHistoryDrawerOpen: Dispatch<SetStateAction<boolean>>;
  setHistoryTerminalSessionId: Dispatch<SetStateAction<string | null>>;
  setBellMarkers: Dispatch<SetStateAction<Record<string, boolean>>>;
  setActiveProjectId: Dispatch<SetStateAction<string | null>>;
  setActiveSessionId: Dispatch<SetStateAction<string | null>>;
  selectActiveSession: (terminalSessionId: string | null) => void;
  removeProjectPreview: (projectId: string) => void;
  loadSessions: () => Promise<void>;
  onAuthExpired?: () => void;
}

export function useTerminalWorkspaceActions({
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
}: UseTerminalWorkspaceActionsArgs) {
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
    setActiveSessionId,
    setLoading,
    setRequestError,
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
    [apiBase, loadSessions, onAuthExpired, setLoading, setRequestError, token],
  );

  const updateSessionAlias = useCallback(
    async (terminalSessionId: string, alias: string): Promise<void> => {
      setLoading(true);
      try {
        const updatedSession = await updateTerminalSession(
          apiBase,
          token,
          terminalSessionId,
          { alias: alias.trim() || null },
        );
        setSessions((currentSessions) =>
          currentSessions.map((session) =>
            session.terminalSessionId === updatedSession.terminalSessionId
              ? updatedSession
              : session,
          ),
        );
        setRequestError(null);
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
    [
      apiBase,
      onAuthExpired,
      setLoading,
      setRequestError,
      setSessions,
      token,
    ],
  );

  const closeProjectDialog = useCallback(() => {
    if (loading) {
      return;
    }
    setProjectDialogError(null);
    setProjectDialogMode(null);
  }, [loading, setProjectDialogError, setProjectDialogMode]);

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
      setActiveProjectId,
      setLoading,
      setProjectDialogError,
      setProjectDialogMode,
      setProjects,
      setSessions,
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
    setActiveProjectId,
    setActiveSessionId,
    setLoading,
    setProjectDialogError,
    setProjectPendingDeletion,
    setRequestError,
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
    [setSessions],
  );

  const handleSessionBell = useCallback(
    (terminalSessionId: string) => {
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
    },
    [setBellMarkers],
  );

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
    [apiBase, loadSessions, setProjects, token],
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
    [activeProjectId, apiBase, loadSessions, setSessions, token],
  );

  const openHistoryDrawer = useCallback(
    (terminalSessionId: string) => {
      setHistoryTerminalSessionId(terminalSessionId);
      setHistoryDrawerOpen(true);
    },
    [setHistoryDrawerOpen, setHistoryTerminalSessionId],
  );

  return {
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
  };
}
