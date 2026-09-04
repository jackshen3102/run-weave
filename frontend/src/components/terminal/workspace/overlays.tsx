import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { DiagnosticLogEntry } from "../../diagnostic-log-entry";
import { TerminalHistoryDrawer } from "../session/history-drawer";
import { TerminalProjectDialog } from "../session/project-dialog";
import { TerminalSessionAliasDialog } from "../session/session-tab";
import { TerminalStatusLookupDialog } from "./status-lookup-dialog";
import { TerminalAgentTeamModelConfigDialog } from "../agent-team/model-config-dialog";
import { useShallow } from "zustand/react/shallow";
import { useTerminalWorkspaceStore } from "../../../features/terminal/state/workspace-store";
import {
  EMPTY_TERMINAL_PROJECTS,
  EMPTY_TERMINAL_SESSIONS,
  useTerminalProjectsQuery,
  useTerminalSessionsQuery,
} from "../../../features/terminal/queries/workspace";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import { formatTerminalSessionName } from "../../../features/terminal/state/session-name";
import {
  formatHistoryPanelLabel,
  resolveHistoryPanelId,
} from "./utils";

interface TerminalWorkspaceOverlaysProps {
  isMobileMonitor: boolean;
  onCloseProjectDialog: () => void;
  onSubmitProjectDialog: (name: string, projectPath: string) => Promise<void>;
  onConfirmDeleteProject: () => void;
  onSubmitSessionAlias: (
    terminalSessionId: string,
    alias: string,
  ) => Promise<void>;
}

export function TerminalWorkspaceOverlays({
  isMobileMonitor,
  onCloseProjectDialog,
  onSubmitProjectDialog,
  onConfirmDeleteProject,
  onSubmitSessionAlias,
}: TerminalWorkspaceOverlaysProps) {
  const { apiBase, token } = useTerminalRuntime();
  const projectsQuery = useTerminalProjectsQuery();
  const sessionsQuery = useTerminalSessionsQuery();
  const projects = projectsQuery.data ?? EMPTY_TERMINAL_PROJECTS;
  const sessions = sessionsQuery.data ?? EMPTY_TERMINAL_SESSIONS;
  const {
    activeProjectId,
    activeParentProjectId,
    activeSessionId,
    mutationLoading,
    projectDialogMode,
    projectDialogError,
    projectPendingDeletion,
    historyDrawerOpen,
    historyTerminalSessionId,
    historyTerminalPanelId,
    aliasTargetSessionId,
    diagnosticLogOpen,
    statusLookupOpen,
    agentTeamModelConfigOpen,
    panelWorkspaceBySessionId,
    activePanelIdBySessionId,
    setProjectPendingDeletion,
    setHistoryDrawerOpen,
    setHistoryTerminalSessionId,
    setHistoryTerminalPanelId,
    closeSessionAlias,
    setDiagnosticLogOpen,
    setStatusLookupOpen,
    setAgentTeamModelConfigOpen,
  } = useTerminalWorkspaceStore(
    useShallow((state) => ({
      activeProjectId: state.activeProjectId,
      activeParentProjectId: state.activeParentProjectId,
      activeSessionId: state.activeSessionId,
      mutationLoading: state.loading,
      projectDialogMode: state.projectDialogMode,
      projectDialogError: state.projectDialogError,
      projectPendingDeletion: state.projectPendingDeletion,
      historyDrawerOpen: state.historyDrawerOpen,
      historyTerminalSessionId: state.historyTerminalSessionId,
      historyTerminalPanelId: state.historyTerminalPanelId,
      aliasTargetSessionId: state.aliasTargetSessionId,
      diagnosticLogOpen: state.diagnosticLogOpen,
      statusLookupOpen: state.statusLookupOpen,
      agentTeamModelConfigOpen: state.agentTeamModelConfigOpen,
      panelWorkspaceBySessionId: state.panelWorkspaceBySessionId,
      activePanelIdBySessionId: state.activePanelIdBySessionId,
      setProjectPendingDeletion: state.setProjectPendingDeletion,
      setHistoryDrawerOpen: state.setHistoryDrawerOpen,
      setHistoryTerminalSessionId: state.setHistoryTerminalSessionId,
      setHistoryTerminalPanelId: state.setHistoryTerminalPanelId,
      closeSessionAlias: state.closeSessionAlias,
      setDiagnosticLogOpen: state.setDiagnosticLogOpen,
      setStatusLookupOpen: state.setStatusLookupOpen,
      setAgentTeamModelConfigOpen: state.setAgentTeamModelConfigOpen,
    })),
  );
  const loading =
    mutationLoading || projectsQuery.isPending || sessionsQuery.isPending;
  const activeProject =
    projects.find(
      (project) => project.projectId === activeParentProjectId,
    ) ?? null;
  const activeSession =
    sessions.find((session) => session.terminalSessionId === activeSessionId) ??
    null;
  const activeWorkspace = activeSession
    ? panelWorkspaceBySessionId[activeSession.terminalSessionId]
    : null;
  const activeStatusLookupPanelId =
    activeSession && activeWorkspace
      ? resolveHistoryPanelId(
          activeWorkspace,
          activePanelIdBySessionId[activeSession.terminalSessionId] ?? null,
        )
      : (activeSession?.activePanelId ?? null);
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
  const aliasTarget =
    sessions.find(
      (session) => session.terminalSessionId === aliasTargetSessionId,
    ) ?? null;
  return (
    <>
      <TerminalProjectDialog
        open={projectDialogMode !== null}
        mode={projectDialogMode ?? "create"}
        loading={loading}
        error={projectDialogError}
        initialName={
          projectDialogMode === "edit" ? (activeProject?.name ?? "") : ""
        }
        initialPath={
          projectDialogMode === "edit" ? (activeProject?.path ?? "") : ""
        }
        onClose={onCloseProjectDialog}
        onSubmit={onSubmitProjectDialog}
      />
      <TerminalHistoryDrawer
        open={historyDrawerOpen}
        target={{
          lastThreadId: historySession?.lastThreadId ?? null,
          lastThreadProvider: historySession?.lastThreadProvider ?? null,
          lastThreadStatus: historySession?.lastThreadStatus ?? null,
          panelId: historyTerminalPanelId,
          panelLastThreadId: historyPanel?.lastThreadId ?? null,
          panelLastThreadProvider: historyPanel?.lastThreadProvider ?? null,
          panelLastThreadStatus: historyPanel?.lastThreadStatus ?? null,
          panelThreadId: historyPanel?.threadId ?? null,
          panelThreadProvider: historyPanel?.threadProvider ?? null,
          projectId: historySession?.projectId ?? null,
          sessionId: historyTerminalSessionId,
          threadId: historySession?.threadId ?? null,
          threadProvider: historySession?.threadProvider ?? null,
        }}
        title={historyTerminalName}
        onOpenChange={(open) => {
          setHistoryDrawerOpen(open);
          if (!open) {
            setHistoryTerminalSessionId(null);
            setHistoryTerminalPanelId(null);
          }
        }}
      />
      <TerminalSessionAliasDialog
        open={aliasTarget !== null}
        loading={loading}
        session={aliasTarget}
        onClose={() => {
          if (!loading) {
            closeSessionAlias();
          }
        }}
        onSubmit={async (alias) => {
          if (!aliasTarget) {
            return;
          }
          await onSubmitSessionAlias(aliasTarget.terminalSessionId, alias);
          closeSessionAlias();
        }}
      />
      {!isMobileMonitor ? (
        <DiagnosticLogEntry
          apiBase={apiBase}
          token={token}
          open={diagnosticLogOpen}
          onOpenChange={setDiagnosticLogOpen}
        />
      ) : null}
      {!isMobileMonitor ? (
        <TerminalStatusLookupDialog
          apiBase={apiBase}
          token={token}
          open={statusLookupOpen}
          onOpenChange={setStatusLookupOpen}
          activeProjectId={activeProjectId}
          activeSessionId={activeSession?.terminalSessionId ?? null}
          activePanelId={activeStatusLookupPanelId}
        />
      ) : null}
      {!isMobileMonitor ? (
        <TerminalAgentTeamModelConfigDialog
          apiBase={apiBase}
          token={token}
          open={agentTeamModelConfigOpen}
          onOpenChange={setAgentTeamModelConfigOpen}
        />
      ) : null}
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
              Delete "{projectPendingDeletion?.name}" and all terminal tabs
              inside it. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={loading}
              className="bg-rose-500 text-white hover:bg-rose-500/90 hover:shadow-[0_22px_50px_-24px_rgba(244,63,94,0.82)]"
              onClick={(event) => {
                event.preventDefault();
                onConfirmDeleteProject();
              }}
            >
              {loading ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
