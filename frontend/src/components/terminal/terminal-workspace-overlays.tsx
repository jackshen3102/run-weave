import type {
  TerminalPanelWorkspace,
  TerminalProjectListItem,
  TerminalSessionListItem,
} from "@runweave/shared";
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

interface TerminalWorkspaceOverlaysProps {
  apiBase: string;
  token: string;
  loading: boolean;
  isMobileMonitor: boolean;
  activeProjectId: string | null;
  activeProject: TerminalProjectListItem | null;
  activeSession: TerminalSessionListItem | null;
  activeStatusLookupPanelId: string | null;
  projectDialogMode: "create" | "edit" | null;
  projectDialogError: string | null;
  projectPendingDeletion: TerminalProjectListItem | null;
  historyDrawerOpen: boolean;
  historyTerminalSessionId: string | null;
  historyTerminalPanelId: string | null;
  historySession: TerminalSessionListItem | null;
  historyPanel: TerminalPanelWorkspace["panels"][number] | null;
  historyTerminalName?: string;
  aliasTarget: TerminalSessionListItem | null;
  diagnosticLogOpen: boolean;
  statusLookupOpen: boolean;
  onCloseProjectDialog: () => void;
  onSubmitProjectDialog: (name: string, projectPath: string) => Promise<void>;
  onConfirmDeleteProject: () => void;
  onProjectPendingDeletionChange: (
    project: TerminalProjectListItem | null,
  ) => void;
  onHistoryDrawerOpenChange: (open: boolean) => void;
  onHistoryTerminalSessionIdChange: (terminalSessionId: string | null) => void;
  onHistoryTerminalPanelIdChange: (terminalPanelId: string | null) => void;
  onAliasTargetChange: (session: TerminalSessionListItem | null) => void;
  onSubmitSessionAlias: (
    terminalSessionId: string,
    alias: string,
  ) => Promise<void>;
  onDiagnosticLogOpenChange: (open: boolean) => void;
  onStatusLookupOpenChange: (open: boolean) => void;
  onAuthExpired?: () => void;
}

export function TerminalWorkspaceOverlays({
  apiBase,
  token,
  loading,
  isMobileMonitor,
  activeProjectId,
  activeProject,
  activeSession,
  activeStatusLookupPanelId,
  projectDialogMode,
  projectDialogError,
  projectPendingDeletion,
  historyDrawerOpen,
  historyTerminalSessionId,
  historyTerminalPanelId,
  historySession,
  historyPanel,
  historyTerminalName,
  aliasTarget,
  diagnosticLogOpen,
  statusLookupOpen,
  onCloseProjectDialog,
  onSubmitProjectDialog,
  onConfirmDeleteProject,
  onProjectPendingDeletionChange,
  onHistoryDrawerOpenChange,
  onHistoryTerminalSessionIdChange,
  onHistoryTerminalPanelIdChange,
  onAliasTargetChange,
  onSubmitSessionAlias,
  onDiagnosticLogOpenChange,
  onStatusLookupOpenChange,
  onAuthExpired,
}: TerminalWorkspaceOverlaysProps) {
  return (
    <>
      <TerminalProjectDialog
        open={projectDialogMode !== null}
        mode={projectDialogMode ?? "create"}
        loading={loading}
        error={projectDialogError}
        initialName={projectDialogMode === "edit" ? activeProject?.name ?? "" : ""}
        initialPath={projectDialogMode === "edit" ? activeProject?.path ?? "" : ""}
        onClose={onCloseProjectDialog}
        onSubmit={onSubmitProjectDialog}
      />
      <TerminalHistoryDrawer
        open={historyDrawerOpen}
        apiBase={apiBase}
        token={token}
        terminalSessionId={historyTerminalSessionId}
        terminalPanelId={historyTerminalPanelId}
        terminalProjectId={historySession?.projectId ?? null}
        terminalThreadId={historySession?.threadId ?? null}
        terminalLastThreadId={historySession?.lastThreadId ?? null}
        terminalLastThreadStatus={historySession?.lastThreadStatus ?? null}
        terminalPanelThreadId={historyPanel?.threadId ?? null}
        terminalPanelLastThreadId={historyPanel?.lastThreadId ?? null}
        terminalPanelLastThreadStatus={historyPanel?.lastThreadStatus ?? null}
        terminalName={historyTerminalName}
        onOpenChange={(open) => {
          onHistoryDrawerOpenChange(open);
          if (!open) {
            onHistoryTerminalSessionIdChange(null);
            onHistoryTerminalPanelIdChange(null);
          }
        }}
        onAuthExpired={onAuthExpired}
      />
      <TerminalSessionAliasDialog
        open={aliasTarget !== null}
        loading={loading}
        session={aliasTarget}
        onClose={() => {
          if (!loading) {
            onAliasTargetChange(null);
          }
        }}
        onSubmit={async (alias) => {
          if (!aliasTarget) {
            return;
          }
          await onSubmitSessionAlias(aliasTarget.terminalSessionId, alias);
          onAliasTargetChange(null);
        }}
      />
      {!isMobileMonitor ? (
        <DiagnosticLogEntry
          apiBase={apiBase}
          token={token}
          open={diagnosticLogOpen}
          onOpenChange={onDiagnosticLogOpenChange}
        />
      ) : null}
      {!isMobileMonitor ? (
        <TerminalStatusLookupDialog
          apiBase={apiBase}
          token={token}
          open={statusLookupOpen}
          onOpenChange={onStatusLookupOpenChange}
          activeProjectId={activeProjectId}
          activeSessionId={activeSession?.terminalSessionId ?? null}
          activePanelId={activeStatusLookupPanelId}
        />
      ) : null}
      <AlertDialog
        open={projectPendingDeletion !== null}
        onOpenChange={(open) => {
          if (!open && !loading) {
            onProjectPendingDeletionChange(null);
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
