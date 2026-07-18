import { useMemoizedFn } from "ahooks";
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
import { useTerminalWorkspaceStore } from "../../features/terminal/workspace-store";
import {
  EMPTY_TERMINAL_PROJECTS,
  EMPTY_TERMINAL_SESSIONS,
  updateTerminalProjects,
  updateTerminalSessions,
  useTerminalProjectsQuery,
  useTerminalSessionsQuery,
  useTerminalWorkspaceQueryClient,
} from "../../features/terminal/queries/terminal-workspace-queries";

interface UseTerminalWorkspaceActionsArgs {
  apiBase: string;
  token: string;
  clientMode: ClientMode;
  removeProjectPreview: (projectId: string) => void;
  loadSessions: () => Promise<void>;
  onAuthExpired?: () => void;
}

export function useTerminalWorkspaceActions({
  apiBase,
  token,
  clientMode,
  removeProjectPreview,
  loadSessions,
  onAuthExpired,
}: UseTerminalWorkspaceActionsArgs) {
  const projects = useTerminalProjectsQuery().data ?? EMPTY_TERMINAL_PROJECTS;
  const sessions = useTerminalSessionsQuery().data ?? EMPTY_TERMINAL_SESSIONS;
  const { queryClient, scope } = useTerminalWorkspaceQueryClient();
  const loading = useTerminalWorkspaceStore((state) => state.loading);
  const activeProjectId = useTerminalWorkspaceStore(
    (state) => state.activeProjectId,
  );
  const activeParentProjectId = useTerminalWorkspaceStore(
    (state) => state.activeParentProjectId,
  );
  const activeSessionId = useTerminalWorkspaceStore(
    (state) => state.activeSessionId,
  );
  const activeProject =
    projects.find(
      (project) => project.projectId === activeParentProjectId,
    ) ?? null;
  const visibleSessions = activeProjectId
    ? sessions.filter((session) => session.projectId === activeProjectId)
    : sessions;
  const activeSession =
    visibleSessions.find(
      (session) => session.terminalSessionId === activeSessionId,
    ) ??
    visibleSessions[0] ??
    null;
  const projectDialogMode = useTerminalWorkspaceStore(
    (state) => state.projectDialogMode,
  );
  const projectPendingDeletion = useTerminalWorkspaceStore(
    (state) => state.projectPendingDeletion,
  );
  const setLoading = useTerminalWorkspaceStore((state) => state.setLoading);
  const setRequestError = useTerminalWorkspaceStore(
    (state) => state.setRequestError,
  );
  const setProjectDialogMode = useTerminalWorkspaceStore(
    (state) => state.setProjectDialogMode,
  );
  const setProjectDialogError = useTerminalWorkspaceStore(
    (state) => state.setProjectDialogError,
  );
  const setProjectPendingDeletion = useTerminalWorkspaceStore(
    (state) => state.setProjectPendingDeletion,
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
  const selectProjectContext = useTerminalWorkspaceStore(
    (state) => state.selectProjectContext,
  );
  const setActiveSessionId = useTerminalWorkspaceStore(
    (state) => state.setActiveSessionId,
  );
  const createSession = useMemoizedFn(async (): Promise<void> => {
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
  });

  const closeSession = useMemoizedFn(
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
  );

  const updateSessionAlias = useMemoizedFn(
    async (terminalSessionId: string, alias: string): Promise<void> => {
      setLoading(true);
      try {
        const updatedSession = await updateTerminalSession(
          apiBase,
          token,
          terminalSessionId,
          { alias: alias.trim() || null },
        );
        updateTerminalSessions(queryClient, scope, (currentSessions) =>
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
  );

  const closeProjectDialog = useMemoizedFn(() => {
    if (loading) {
      return;
    }
    setProjectDialogError(null);
    setProjectDialogMode(null);
  });

  const submitProjectDialog = useMemoizedFn(
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
          updateTerminalProjects(queryClient, scope, (currentProjects) =>
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
          updateTerminalProjects(queryClient, scope, (currentProjects) => [
            ...currentProjects.filter(
              (project) => project.projectId !== createdProject.projectId,
            ),
            createdProject,
          ]);
          selectProjectContext(
            createdProject.projectId,
            createdProject.projectId,
            createdSession.terminalSessionId,
          );
          const createdAt = new Date().toISOString();
          updateTerminalSessions(queryClient, scope, (currentSessions) => [
            ...currentSessions.filter(
              (session) =>
                session.terminalSessionId !== createdSession.terminalSessionId,
            ),
            {
              terminalSessionId: createdSession.terminalSessionId,
              projectId: createdProject.projectId,
              command: "",
              args: [],
              cwd: "",
              activeCommand: null,
              completionRevision: 0,
              acknowledgedCompletionRevision: 0,
              status: "running",
              createdAt,
              lastActivityAt: createdAt,
              panelSplitEnabled: false,
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
  );

  const removeProject = useMemoizedFn(async (): Promise<void> => {
    const targetProject = projectPendingDeletion ?? activeProject;
    if (!targetProject) {
      return;
    }
    setLoading(true);
    try {
      await deleteTerminalProject(apiBase, token, targetProject.projectId);
      setRequestError(null);
      setProjectDialogError(null);
      selectProjectContext(null, null, null);
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
  });

  const handleProjectReorder = useMemoizedFn(
    (fromIndex: number, toIndex: number) => {
      updateTerminalProjects(queryClient, scope, (current) => {
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
  );

  const handleSessionReorder = useMemoizedFn(
    (fromIndex: number, toIndex: number) => {
      if (!activeProjectId) {
        return;
      }
      updateTerminalSessions(queryClient, scope, (current) => {
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
  );

  const openHistoryDrawer = useMemoizedFn((terminalSessionId: string) => {
    setHistoryTerminalSessionId(terminalSessionId);
    setHistoryTerminalPanelId(null);
    setHistoryDrawerOpen(true);
  });

  return {
    createSession,
    closeSession,
    updateSessionAlias,
    closeProjectDialog,
    submitProjectDialog,
    removeProject,
    handleProjectReorder,
    handleSessionReorder,
    openHistoryDrawer,
  };
}
