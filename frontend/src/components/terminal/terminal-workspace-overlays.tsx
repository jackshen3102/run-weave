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
import { DiagnosticLogEntry } from "../diagnostic-log-entry";
import { TerminalHistoryDrawer } from "./terminal-history-drawer";
import { TerminalProjectDialog } from "./terminal-project-dialog";
import { TerminalSessionAliasDialog } from "./terminal-session-tab";
import { TerminalStatusLookupDialog } from "./terminal-status-lookup-dialog";
import { useTerminalWorkspaceStore } from "../../features/terminal/workspace-store";
import {
  EMPTY_TERMINAL_PROJECTS,
  EMPTY_TERMINAL_SESSIONS,
  useTerminalProjectsQuery,
  useTerminalSessionsQuery,
} from "../../features/terminal/queries/terminal-workspace-queries";
import { useTerminalRuntime } from "../../features/terminal/queries/terminal-runtime-provider";
import { formatTerminalSessionName } from "../../features/terminal/session-name";
import {
  formatHistoryPanelLabel,
  resolveHistoryPanelId,
} from "./terminal-workspace-utils";

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
  const activeProjectId = useTerminalWorkspaceStore(
    (state) => state.activeProjectId,
  );
  const activeSessionId = useTerminalWorkspaceStore(
    (state) => state.activeSessionId,
  );
  const mutationLoading = useTerminalWorkspaceStore((state) => state.loading);
  const projectDialogMode = useTerminalWorkspaceStore(
    (state) => state.projectDialogMode,
  );
  const projectDialogError = useTerminalWorkspaceStore(
    (state) => state.projectDialogError,
  );
  const projectPendingDeletion = useTerminalWorkspaceStore(
    (state) => state.projectPendingDeletion,
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
  const aliasTargetSessionId = useTerminalWorkspaceStore(
    (state) => state.aliasTargetSessionId,
  );
  const diagnosticLogOpen = useTerminalWorkspaceStore(
    (state) => state.diagnosticLogOpen,
  );
  const statusLookupOpen = useTerminalWorkspaceStore(
    (state) => state.statusLookupOpen,
  );
  const panelWorkspaceBySessionId = useTerminalWorkspaceStore(
    (state) => state.panelWorkspaceBySessionId,
  );
  const activePanelIdBySessionId = useTerminalWorkspaceStore(
    (state) => state.activePanelIdBySessionId,
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
  const closeSessionAlias = useTerminalWorkspaceStore(
    (state) => state.closeSessionAlias,
  );
  const setDiagnosticLogOpen = useTerminalWorkspaceStore(
    (state) => state.setDiagnosticLogOpen,
  );
  const setStatusLookupOpen = useTerminalWorkspaceStore(
    (state) => state.setStatusLookupOpen,
  );
  const loading =
    mutationLoading || projectsQuery.isPending || sessionsQuery.isPending;
  const activeProject =
    projects.find((project) => project.projectId === activeProjectId) ?? null;
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
