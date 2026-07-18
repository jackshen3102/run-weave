import { useEffect, useMemo } from "react";
import { useMemoizedFn } from "ahooks";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import type { ConnectionConfig } from "../../features/connection/types";
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
import { useTerminalRuntime } from "../../features/terminal/queries/terminal-runtime-provider";
import type { ClientMode } from "../../features/client-mode";
import {
  listTerminalPanels,
  resizeTerminalPanel,
  updateTerminalSession,
} from "../../services/terminal";
import { HttpError } from "../../services/http";
import { TerminalWorkspaceHeader } from "./terminal-workspace-header";
import { TerminalSessionTabStrip } from "./terminal-session-tab-strip";
import { TerminalWorkspaceStage } from "./terminal-workspace-stage";
import { TerminalWorkspaceOverlays } from "./terminal-workspace-overlays";
import { useTerminalWorkspaceAgentTeam } from "./use-terminal-workspace-agent-team";
import { TerminalWorktreeRail } from "./terminal-worktree-rail";

interface WorkspaceConnectionNavigation {
  connections?: ConnectionConfig[];
  activeConnectionId?: string | null;
  connectionName?: string;
  onSelect?: (connectionId: string) => void;
  onOpenManager?: () => void;
  onNavigateHome?: () => void;
}

interface WorkspaceProjectCommands {
  onSelect: (projectId: string) => void;
  onSelectContext: (projectId: string) => void;
  onCloseDialog: () => void;
  onSubmitDialog: (name: string, projectPath: string) => Promise<void>;
  onConfirmDelete: () => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

interface WorkspaceSessionCommands {
  onSelect: (terminalSessionId: string) => void;
  onRequestCreate: () => void;
  onRequestClose: (terminalSessionId: string) => void;
  onSubmitAlias: (terminalSessionId: string, alias: string) => Promise<void>;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

interface TerminalWorkspaceShellProps {
  clientMode: ClientMode;
  className?: string;
  connection: WorkspaceConnectionNavigation;
  projects: WorkspaceProjectCommands;
  sessions: WorkspaceSessionCommands;
}

export function TerminalWorkspaceShell({
  clientMode,
  className,
  connection,
  projects: projectCommands,
  sessions: sessionCommands,
}: TerminalWorkspaceShellProps) {
  const { apiBase, onAuthExpired, token } = useTerminalRuntime();
  const {
    activeConnectionId,
    connectionName,
    connections,
    onNavigateHome,
    onOpenManager: onOpenConnectionManager,
    onSelect: onSelectConnection,
  } = connection;
  const {
    onCloseDialog: onCloseProjectDialog,
    onConfirmDelete: onConfirmDeleteProject,
    onReorder: onReorderProjects,
    onSelect: onSelectProject,
    onSelectContext,
    onSubmitDialog: onSubmitProjectDialog,
  } = projectCommands;
  const {
    onReorder: onReorderSessions,
    onRequestClose: onRequestCloseSession,
    onRequestCreate: onRequestCreateSession,
    onSelect: onSelectSession,
    onSubmitAlias: onSubmitSessionAlias,
  } = sessionCommands;
  const isMobileMonitor = clientMode === "mobile";
  const projectsQuery = useTerminalProjectsQuery();
  const sessionsQuery = useTerminalSessionsQuery();
  const projects = projectsQuery.data ?? EMPTY_TERMINAL_PROJECTS;
  const sessions = sessionsQuery.data ?? EMPTY_TERMINAL_SESSIONS;
  const { queryClient, scope } = useTerminalWorkspaceQueryClient();
  const activeProjectId = useTerminalWorkspaceStore(
    (state) => state.activeProjectId,
  );
  const activeParentProjectId = useTerminalWorkspaceStore(
    (state) => state.activeParentProjectId,
  );
  const contextsQuery = useTerminalProjectContextsQuery(activeParentProjectId);
  const contexts =
    contextsQuery.data ?? EMPTY_TERMINAL_PROJECT_CONTEXTS;
  const activeSessionId = useTerminalWorkspaceStore(
    (state) => state.activeSessionId,
  );
  const mutationLoading = useTerminalWorkspaceStore((state) => state.loading);
  const loading =
    mutationLoading || projectsQuery.isPending || sessionsQuery.isPending;
  const setRequestError = useTerminalWorkspaceStore(
    (state) => state.setRequestError,
  );
  const setPanelWorkspaceBySessionId = useTerminalWorkspaceStore(
    (state) => state.setPanelWorkspaceBySessionId,
  );
  const setActivePanelIdBySessionId = useTerminalWorkspaceStore(
    (state) => state.setActivePanelIdBySessionId,
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
  const openSessionAlias = useTerminalWorkspaceStore(
    (state) => state.openSessionAlias,
  );
  const setPreviewActiveTool = useTerminalPreviewStore(
    (state) => state.setActiveTool,
  );
  const visibleSessions = useMemo(() => {
    if (!activeProjectId) {
      return [];
    }
    return sessions.filter((session) => session.projectId === activeProjectId);
  }, [activeProjectId, sessions]);
  const activeParentProject =
    projects.find(
      (project) => project.projectId === activeParentProjectId,
    ) ?? null;
  const activeContext =
    contexts.find((context) => context.projectId === activeProjectId) ?? null;
  const activeProject =
    activeParentProject && activeContext
      ? {
          ...activeParentProject,
          projectId: activeContext.projectId,
          name: activeContext.name,
          path: activeContext.path,
        }
      : activeParentProject?.projectId === activeProjectId
        ? activeParentProject
        : null;
  const activeSession = activeSessionId
    ? (visibleSessions.find(
        (session) => session.terminalSessionId === activeSessionId,
      ) ?? null)
    : null;
  const panelSplitEnabled = activeSession?.panelSplitEnabled ?? false;
  const requestCreateProject = useMemoizedFn(() => {
    setPreviewActiveTool("preview");
    setProjectDialogError(null);
    setProjectDialogMode("create");
  });
  const requestEditProject = useMemoizedFn((projectId?: string) => {
    setPreviewActiveTool("preview");
    if (projectId) {
      onSelectProject(projectId);
    }
    setProjectDialogError(null);
    setProjectDialogMode("edit");
  });
  const requestDeleteProject = useMemoizedFn(
    (project: TerminalProjectListItem) => {
      setPreviewActiveTool("preview");
      setProjectPendingDeletion(project);
    },
  );
  const selectProjectFromTabBar = useMemoizedFn(onSelectProject);
  const reorderProjectsFromTabBar = useMemoizedFn(onReorderProjects);
  const setPanelSplitEnabled = useMemoizedFn(
    async (
      terminalSessionId: string,
      enabled: boolean,
    ): Promise<TerminalSessionListItem | null> => {
      try {
        const updatedSession = await updateTerminalSession(
          apiBase,
          token,
          terminalSessionId,
          { panelSplitEnabled: enabled },
        );
        setRequestError(null);
        updateTerminalSessions(queryClient, scope, (currentSessions) =>
          currentSessions.map((session) =>
            session.terminalSessionId === terminalSessionId
              ? updatedSession
              : session,
          ),
        );
        return updatedSession;
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) {
          onAuthExpired?.();
          return null;
        }
        setRequestError(String(error));
        return null;
      }
    },
  );
  const resizePanel = useMemoizedFn(
    async (
      terminalSessionId: string,
      panelId: string,
      direction: "left" | "right" | "up" | "down",
      cells: number,
    ): Promise<void> => {
      try {
        const workspace = await resizeTerminalPanel(
          apiBase,
          token,
          terminalSessionId,
          panelId,
          { direction, cells },
        );
        setRequestError(null);
        setPanelWorkspaceBySessionId((current) => ({
          ...current,
          [workspace.terminalSessionId]: workspace,
        }));
        setActivePanelIdBySessionId((current) => ({
          ...current,
          [workspace.terminalSessionId]: workspace.activePanelId,
        }));
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) {
          onAuthExpired?.();
          return;
        }
        setRequestError(String(error));
      }
    },
  );
  const refreshPanelWorkspace = useMemoizedFn(
    async (terminalSessionId: string): Promise<void> => {
      // Let the backend apply the tmux window refit that the WS resize just
      // triggered before we read back pane geometry, otherwise the handles
      // reposition against the pre-resize columns.
      await new Promise((resolve) => setTimeout(resolve, 150));
      try {
        const workspace = await listTerminalPanels(
          apiBase,
          token,
          terminalSessionId,
        );
        setPanelWorkspaceBySessionId((current) => ({
          ...current,
          [workspace.terminalSessionId]: workspace,
        }));
      } catch {
        // Geometry refresh is best-effort; a stale handle simply repositions on
        // the next successful fetch.
      }
    },
  );
  const {
    requestAgentTeam,
    showAgentTeamTool,
    syncActiveAgentTeamRunForActiveSession,
  } = useTerminalWorkspaceAgentTeam({
    apiBase,
    token,
    activeProject,
    activeSession,
    panelSplitEnabled,
    onSelectSession,
    setPanelSplitEnabled,
  });

  useEffect(() => {
    if (
      !activeSession?.terminalSessionId ||
      isMobileMonitor ||
      !panelSplitEnabled
    ) {
      return;
    }
    let cancelled = false;
    void listTerminalPanels(apiBase, token, activeSession.terminalSessionId)
      .then((workspace) => {
        if (cancelled) {
          return;
        }
        setPanelWorkspaceBySessionId((current) => ({
          ...current,
          [workspace.terminalSessionId]: workspace,
        }));
        setActivePanelIdBySessionId((current) => ({
          ...current,
          [workspace.terminalSessionId]: workspace.activePanelId,
        }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    activeSession?.terminalSessionId,
    apiBase,
    isMobileMonitor,
    panelSplitEnabled,
    setActivePanelIdBySessionId,
    setPanelWorkspaceBySessionId,
    token,
  ]);

  return (
    <section
      className={[
        "flex h-full min-h-0 flex-col overflow-hidden bg-slate-950 text-slate-100",
        "dark",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <TerminalWorkspaceHeader
        loading={loading}
        isMobileMonitor={isMobileMonitor}
        connection={{
          activeConnectionId,
          connectionName,
          connections,
          onNavigateHome,
          onOpenManager: onOpenConnectionManager,
          onSelect: onSelectConnection,
        }}
        projects={{
          onReorderProjects: reorderProjectsFromTabBar,
          onSelectProject: selectProjectFromTabBar,
          requestCreateProject,
          requestDeleteProject,
          requestEditProject,
        }}
      />
      <div className="flex min-h-0 flex-1">
        {!isMobileMonitor ? (
          <TerminalWorktreeRail
            parentProjectId={activeParentProjectId}
            onSelectContext={onSelectContext}
          />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <TerminalSessionTabStrip
            visibleSessions={visibleSessions}
            isMobileMonitor={isMobileMonitor}
            loading={loading}
            onReorderSessions={onReorderSessions}
            onSelectSession={onSelectSession}
            onRequestCloseSession={onRequestCloseSession}
            onRequestEditAlias={(session) =>
              openSessionAlias(session.terminalSessionId)
            }
            onPanelSplitEnabledChange={(terminalSessionId, enabled) => {
              void setPanelSplitEnabled(terminalSessionId, enabled);
            }}
            onRequestAgentTeam={requestAgentTeam}
            onRequestCreateSession={onRequestCreateSession}
          />
          <TerminalWorkspaceStage
            clientMode={clientMode}
            showAgentTeamTool={showAgentTeamTool}
            onEditProject={() => requestEditProject()}
            panels={{
          onActiveAgentTeamRunChange: syncActiveAgentTeamRunForActiveSession,
          onPanelSplitEnabledChange: (enabled) => {
            if (activeSession) {
              void setPanelSplitEnabled(
                activeSession.terminalSessionId,
                enabled,
              );
            }
          },
          onPanelWorkspaceChange: (workspace) => {
            setPanelWorkspaceBySessionId((current) => ({
              ...current,
              [workspace.terminalSessionId]: workspace,
            }));
            setActivePanelIdBySessionId((current) => ({
              ...current,
              [workspace.terminalSessionId]: workspace.activePanelId,
            }));
          },
          onRefreshPanelWorkspace: (terminalSessionId) =>
            void refreshPanelWorkspace(terminalSessionId),
          onResizePanel: (terminalSessionId, panelId, direction, cells) => {
            void resizePanel(terminalSessionId, panelId, direction, cells);
          },
            }}
          />
        </div>
      </div>
      <TerminalWorkspaceOverlays
        isMobileMonitor={isMobileMonitor}
        onCloseProjectDialog={onCloseProjectDialog}
        onSubmitProjectDialog={onSubmitProjectDialog}
        onConfirmDeleteProject={onConfirmDeleteProject}
        onSubmitSessionAlias={onSubmitSessionAlias}
      />
    </section>
  );
}
