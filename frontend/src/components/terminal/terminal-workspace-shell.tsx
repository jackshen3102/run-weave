import { useEffect, useMemo, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type { TerminalProjectListItem, TerminalSessionListItem } from "@runweave/shared";
import type { ConnectionConfig } from "../../features/connection/types";
import {
  DEFAULT_TERMINAL_SIDECAR_WIDTH,
  useTerminalPreviewStore,
} from "../../features/terminal/preview-store";
import { useTerminalWorkspaceStore } from "../../features/terminal/workspace-store";
import type { ClientMode } from "../../features/client-mode";
import { formatTerminalSessionName } from "../../features/terminal/session-name";
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
import {
  formatHistoryPanelLabel,
  HEADLESS_TERMINAL_CONNECTION_DELAY_MS,
  MAX_HEADLESS_TERMINAL_CONNECTIONS,
  parseTerminalActivityTime,
  resolveHistoryPanelId,
} from "./terminal-workspace-utils";

interface TerminalWorkspaceShellProps {
  apiBase: string;
  token: string;
  clientMode: ClientMode;
  className?: string;
  connections?: ConnectionConfig[];
  activeConnectionId?: string | null;
  connectionName?: string;
  onSelectConnection?: (connectionId: string) => void;
  onOpenConnectionManager?: () => void;
  onNavigateHome?: () => void;
  onAuthExpired?: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (terminalSessionId: string) => void;
  onRequestCreateSession: () => void;
  onRequestCloseSession: (terminalSessionId: string) => void;
  onSubmitSessionAlias: (
    terminalSessionId: string,
    alias: string,
  ) => Promise<void>;
  onCloseProjectDialog: () => void;
  onSubmitProjectDialog: (name: string, projectPath: string) => Promise<void>;
  onConfirmDeleteProject: () => void;
  onReorderProjects: (fromIndex: number, toIndex: number) => void;
  onReorderSessions: (fromIndex: number, toIndex: number) => void;
  onSessionBell: (terminalSessionId: string) => void;
  onSessionMetadata: (
    terminalSessionId: string,
    metadata: { cwd: string; activeCommand: string | null },
  ) => void;
}

export function TerminalWorkspaceShell({
  apiBase,
  token,
  clientMode,
  className,
  connections,
  activeConnectionId,
  connectionName,
  onSelectConnection,
  onOpenConnectionManager,
  onNavigateHome,
  onAuthExpired,
  onSelectProject,
  onSelectSession,
  onRequestCreateSession,
  onRequestCloseSession,
  onSubmitSessionAlias,
  onCloseProjectDialog,
  onSubmitProjectDialog,
  onConfirmDeleteProject,
  onReorderProjects,
  onReorderSessions,
  onSessionBell,
  onSessionMetadata,
}: TerminalWorkspaceShellProps) {
  const [aliasTarget, setAliasTarget] =
    useState<TerminalSessionListItem | null>(null);
  const [diagnosticLogOpen, setDiagnosticLogOpen] = useState(false);
  const [statusLookupOpen, setStatusLookupOpen] = useState(false);
  const [headlessConnectionsEnabled, setHeadlessConnectionsEnabled] =
    useState(false);
  const isMobileMonitor = clientMode === "mobile";
  const projects = useTerminalWorkspaceStore((state) => state.projects);
  const sessions = useTerminalWorkspaceStore((state) => state.sessions);
  const setSessions = useTerminalWorkspaceStore((state) => state.setSessions);
  const activeProjectId = useTerminalWorkspaceStore(
    (state) => state.activeProjectId,
  );
  const activeSessionId = useTerminalWorkspaceStore(
    (state) => state.activeSessionId,
  );
  const loading = useTerminalWorkspaceStore((state) => state.loading);
  const requestError = useTerminalWorkspaceStore((state) => state.requestError);
  const setRequestError = useTerminalWorkspaceStore(
    (state) => state.setRequestError,
  );
  const cachedSurfaceSessionIds = useTerminalWorkspaceStore(
    (state) => state.cachedSurfaceSessionIds,
  );
  const historyDrawerOpen = useTerminalWorkspaceStore(
    (state) => state.historyDrawerOpen,
  );
  const historyTerminalSessionId = useTerminalWorkspaceStore(
    (state) => state.historyTerminalSessionId,
  );
  const historyTerminalPanelId = useTerminalWorkspaceStore(
    (state) => state.historyTerminalPanelId,
  );
  const projectDialogMode = useTerminalWorkspaceStore(
    (state) => state.projectDialogMode,
  );
  const projectDialogError = useTerminalWorkspaceStore(
    (state) => state.projectDialogError,
  );
  const projectPendingDeletion = useTerminalWorkspaceStore(
    (state) => state.projectPendingDeletion,
  );
  const completionMarkers = useTerminalWorkspaceStore(
    (state) => state.completionMarkers,
  );
  const bellMarkers = useTerminalWorkspaceStore((state) => state.bellMarkers);
  const terminalStateBySessionId = useTerminalWorkspaceStore(
    (state) => state.terminalStateBySessionId,
  );
  const panelWorkspaceBySessionId = useTerminalWorkspaceStore(
    (state) => state.panelWorkspaceBySessionId,
  );
  const activePanelIdBySessionId = useTerminalWorkspaceStore(
    (state) => state.activePanelIdBySessionId,
  );
  const setPanelWorkspaceBySessionId = useTerminalWorkspaceStore(
    (state) => state.setPanelWorkspaceBySessionId,
  );
  const setActivePanelIdBySessionId = useTerminalWorkspaceStore(
    (state) => state.setActivePanelIdBySessionId,
  );
  const setActiveProjectId = useTerminalWorkspaceStore(
    (state) => state.setActiveProjectId,
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
  const previewOpen = useTerminalPreviewStore((state) => state.ui.open);
  const previewWidthPx = useTerminalPreviewStore((state) => state.ui.widthPx);
  const previewExpanded = useTerminalPreviewStore((state) => state.ui.expanded);
  const setPreviewActiveTool = useTerminalPreviewStore(
    (state) => state.setActiveTool,
  );
  const previewReservedWidth = previewWidthPx
    ? `${previewWidthPx}px`
    : DEFAULT_TERMINAL_SIDECAR_WIDTH;
  const visibleProjects = projects;
  const visibleSessions = useMemo(() => {
    if (!activeProjectId) {
      return [];
    }
    return sessions.filter((session) =>
      session.projectId === activeProjectId,
    );
  }, [activeProjectId, sessions]);
  const activeProject =
    visibleProjects.find((project) => project.projectId === activeProjectId) ??
    null;
  const activeSession =
    activeSessionId
      ? visibleSessions.find(
          (session) => session.terminalSessionId === activeSessionId,
        ) ?? null
      : null;
  const panelSplitEnabled = activeSession?.panelSplitEnabled ?? false;
  const terminalLayoutVersion = isMobileMonitor
    ? "mobile"
    : `desktop:${previewOpen ? previewReservedWidth : "full"}:${panelSplitEnabled ? "panel-split" : "single"}`;
  const surfaceSessions = useMemo(() => {
    const surfaceSessionIds = new Set(cachedSurfaceSessionIds);
    if (activeSession?.terminalSessionId) {
      surfaceSessionIds.add(activeSession.terminalSessionId);
    }
    return sessions.filter((session) =>
      surfaceSessionIds.has(session.terminalSessionId),
    );
  }, [activeSession?.terminalSessionId, cachedSurfaceSessionIds, sessions]);
  const surfaceSessionIdSet = useMemo(
    () =>
      new Set(surfaceSessions.map((session) => session.terminalSessionId)),
    [surfaceSessions],
  );
  const headlessSessions = useMemo(() => {
    if (!headlessConnectionsEnabled) {
      return [];
    }
    return visibleSessions
      .filter(
        (session) =>
          session.status === "running" &&
          !surfaceSessionIdSet.has(session.terminalSessionId),
      )
      .sort(
        (a, b) =>
          parseTerminalActivityTime(b.lastActivityAt) -
          parseTerminalActivityTime(a.lastActivityAt),
      )
      .slice(0, MAX_HEADLESS_TERMINAL_CONNECTIONS);
  }, [headlessConnectionsEnabled, surfaceSessionIdSet, visibleSessions]);
  const activePanelWorkspace = activeSession
    ? panelWorkspaceBySessionId[activeSession.terminalSessionId] ?? null
    : null;
  const activeHistoryPanelId =
    activeSession?.tmuxSessionName && activePanelWorkspace
      ? resolveHistoryPanelId(
          activePanelWorkspace,
          activePanelIdBySessionId[activeSession.terminalSessionId] ?? null,
        )
      : null;
  const activeStatusLookupPanelId =
    activeHistoryPanelId ??
    (activeSession
      ? activePanelIdBySessionId[activeSession.terminalSessionId] ??
        activeSession.activePanelId ??
        null
      : null);
  const historySession =
    sessions.find(
      (session) => session.terminalSessionId === historyTerminalSessionId,
    ) ?? null;
  const historyPanel = historyTerminalSessionId
    ? (panelWorkspaceBySessionId[historyTerminalSessionId]?.panels.find(
        (panel) => panel.panelId === historyTerminalPanelId,
      ) ?? null)
    : null;
  const historyTerminalName = historySession
    ? [
        formatTerminalSessionName({
          alias: historySession.alias,
          cwd: historySession.cwd,
          activeCommand: historySession.activeCommand,
        }),
        historyPanel ? formatHistoryPanelLabel(historyPanel) : null,
      ]
        .filter(Boolean)
        .join(" / ")
    : undefined;
  const requestCreateProject = () => {
    setPreviewActiveTool("preview");
    setProjectDialogError(null);
    setProjectDialogMode("create");
  };
  const requestEditProject = (projectId?: string) => {
    setPreviewActiveTool("preview");
    if (projectId) {
      setActiveProjectId(projectId);
    }
    setProjectDialogError(null);
    setProjectDialogMode("edit");
  };
  const requestDeleteProject = (project: TerminalProjectListItem) => {
    setPreviewActiveTool("preview");
    setProjectPendingDeletion(project);
  };
  const openHistoryDrawer = (
    terminalSessionId: string,
    terminalPanelId?: string | null,
  ) => {
    setHistoryTerminalSessionId(terminalSessionId);
    setHistoryTerminalPanelId(terminalPanelId ?? null);
    setHistoryDrawerOpen(true);
  };
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
        setSessions((currentSessions) =>
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
    setHeadlessConnectionsEnabled(false);
    if (!activeProjectId || visibleSessions.length <= 1) {
      return;
    }
    const timer = window.setTimeout(() => {
      setHeadlessConnectionsEnabled(true);
    }, HEADLESS_TERMINAL_CONNECTION_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [activeProjectId, apiBase, visibleSessions.length]);

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
        apiBase={apiBase}
        token={token}
        loading={loading}
        isMobileMonitor={isMobileMonitor}
        connections={connections}
        activeConnectionId={activeConnectionId}
        connectionName={connectionName}
        onSelectConnection={onSelectConnection}
        onOpenConnectionManager={onOpenConnectionManager}
        onNavigateHome={onNavigateHome}
        visibleProjects={visibleProjects}
        activeProjectId={activeProjectId}
        sessions={sessions}
        completionMarkers={completionMarkers}
        bellMarkers={bellMarkers}
        terminalStateBySessionId={terminalStateBySessionId}
        onReorderProjects={onReorderProjects}
        onSelectProject={onSelectProject}
        requestEditProject={requestEditProject}
        requestDeleteProject={requestDeleteProject}
        requestCreateProject={requestCreateProject}
        activeProject={activeProject}
        activeSession={activeSession}
        openHistoryDrawer={openHistoryDrawer}
        activeHistoryPanelId={activeHistoryPanelId}
        setDiagnosticLogOpen={setDiagnosticLogOpen}
        setStatusLookupOpen={setStatusLookupOpen}
      />
      <TerminalSessionTabStrip
        visibleSessions={visibleSessions}
        activeSession={activeSession}
        isMobileMonitor={isMobileMonitor}
        loading={loading}
        bellMarkers={bellMarkers}
        completionMarkers={completionMarkers}
        terminalStateBySessionId={terminalStateBySessionId}
        panelWorkspaceBySessionId={panelWorkspaceBySessionId}
        onReorderSessions={onReorderSessions}
        onSelectSession={onSelectSession}
        onRequestCloseSession={onRequestCloseSession}
        onRequestEditAlias={setAliasTarget}
        onPanelSplitEnabledChange={(terminalSessionId, enabled) => {
          void setPanelSplitEnabled(terminalSessionId, enabled);
        }}
        onRequestAgentTeam={requestAgentTeam}
        onRequestCreateSession={onRequestCreateSession}
      />

      <TerminalWorkspaceStage
        apiBase={apiBase}
        token={token}
        clientMode={clientMode}
        isMobileMonitor={isMobileMonitor}
        requestError={requestError}
        activeSession={activeSession}
        visibleSessions={visibleSessions}
        headlessSessions={headlessSessions}
        surfaceSessions={surfaceSessions}
        panelSplitEnabled={panelSplitEnabled}
        activePanelWorkspace={activePanelWorkspace}
        terminalLayoutVersion={terminalLayoutVersion}
        terminalStateBySessionId={terminalStateBySessionId}
        panelWorkspaceBySessionId={panelWorkspaceBySessionId}
        previewOpen={previewOpen}
        previewExpanded={previewExpanded}
        previewWidthPx={previewWidthPx}
        previewReservedWidth={previewReservedWidth}
        activeProject={activeProject}
        showAgentTeamTool={showAgentTeamTool}
        sessions={sessions}
        onAuthExpired={onAuthExpired}
        onPanelWorkspaceChange={(workspace) => {
          setPanelWorkspaceBySessionId((current) => ({
            ...current,
            [workspace.terminalSessionId]: workspace,
          }));
          setActivePanelIdBySessionId((current) => ({
            ...current,
            [workspace.terminalSessionId]: workspace.activePanelId,
          }));
        }}
        onResizePanel={(terminalSessionId, panelId, direction, cells) => {
          void resizePanel(terminalSessionId, panelId, direction, cells);
        }}
        onRefreshPanelWorkspace={(terminalSessionId) => {
          void refreshPanelWorkspace(terminalSessionId);
        }}
        onSessionBell={onSessionBell}
        onSessionMetadata={onSessionMetadata}
        onSelectSession={onSelectSession}
        onPanelSplitEnabledChange={(enabled) => {
          if (activeSession) {
            void setPanelSplitEnabled(activeSession.terminalSessionId, enabled);
          }
        }}
        onActiveAgentTeamRunChange={syncActiveAgentTeamRunForActiveSession}
        onEditProject={() => {
          requestEditProject();
        }}
      />
      <TerminalWorkspaceOverlays
        apiBase={apiBase}
        token={token}
        loading={loading}
        isMobileMonitor={isMobileMonitor}
        activeProjectId={activeProjectId}
        activeProject={activeProject}
        activeSession={activeSession}
        activeStatusLookupPanelId={activeStatusLookupPanelId}
        projectDialogMode={projectDialogMode}
        projectDialogError={projectDialogError}
        projectPendingDeletion={projectPendingDeletion}
        historyDrawerOpen={historyDrawerOpen}
        historyTerminalSessionId={historyTerminalSessionId}
        historyTerminalPanelId={historyTerminalPanelId}
        historySession={historySession}
        historyPanel={historyPanel}
        historyTerminalName={historyTerminalName}
        aliasTarget={aliasTarget}
        diagnosticLogOpen={diagnosticLogOpen}
        statusLookupOpen={statusLookupOpen}
        onCloseProjectDialog={onCloseProjectDialog}
        onSubmitProjectDialog={onSubmitProjectDialog}
        onConfirmDeleteProject={onConfirmDeleteProject}
        onProjectPendingDeletionChange={setProjectPendingDeletion}
        onHistoryDrawerOpenChange={setHistoryDrawerOpen}
        onHistoryTerminalSessionIdChange={setHistoryTerminalSessionId}
        onHistoryTerminalPanelIdChange={setHistoryTerminalPanelId}
        onAliasTargetChange={setAliasTarget}
        onSubmitSessionAlias={onSubmitSessionAlias}
        onDiagnosticLogOpenChange={setDiagnosticLogOpen}
        onStatusLookupOpenChange={setStatusLookupOpen}
        onAuthExpired={onAuthExpired}
      />
    </section>
  );
}
