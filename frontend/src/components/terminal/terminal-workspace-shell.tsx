import { lazy, Suspense } from "react";
import type { TerminalProjectListItem, TerminalSessionListItem } from "@browser-viewer/shared";
import { History, Home, Pencil, Plus, Trash2, X } from "lucide-react";
import type { ConnectionConfig } from "../../features/connection/types";
import { DEFAULT_TERMINAL_SIDECAR_WIDTH } from "../../features/terminal/preview-store";
import type { ClientMode } from "../../features/client-mode";
import { formatTerminalSessionName } from "../../features/terminal/session-name";
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
import { TerminalHistoryDrawer } from "./terminal-history-drawer";
import { TerminalPreviewMenu } from "./terminal-preview-menu";
import { TerminalProjectDialog } from "./terminal-project-dialog";
import { TerminalHeadlessConnection } from "./terminal-headless-connection";
import { TerminalSurface } from "./terminal-surface";

const TerminalPreviewPanel = lazy(() =>
  import("./terminal-preview-panel").then((module) => ({
    default: module.TerminalPreviewPanel,
  })),
);

function buildSessionLabel(session: TerminalSessionListItem): string {
  const renderedArgs = session.args.join(" ");
  return renderedArgs ? `${session.command} ${renderedArgs}` : session.command;
}

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
  loading: boolean;
  requestError: string | null;
  isMobileMonitor: boolean;
  visibleProjects: TerminalProjectListItem[];
  visibleSessions: TerminalSessionListItem[];
  sessions: TerminalSessionListItem[];
  activeProjectId: string | null;
  activeProject: TerminalProjectListItem | null;
  activeSession: TerminalSessionListItem | null;
  previewOpen: boolean;
  previewExpanded: boolean;
  previewWidthPx?: number;
  previewReservedWidth: string;
  cachedSurfaceSessionIdSet: Set<string>;
  historyDrawerOpen: boolean;
  historyTerminalSessionId: string | null;
  historyTerminalName?: string;
  projectDialogMode: "create" | "edit" | null;
  projectDialogError: string | null;
  projectPendingDeletion: TerminalProjectListItem | null;
  activityMarkers: Record<string, boolean>;
  bellMarkers: Record<string, boolean>;
  terminalLayoutVersion: string;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (terminalSessionId: string) => void;
  onRequestCreateProject: () => void;
  onRequestEditProject: (projectId?: string) => void;
  onRequestDeleteProject: (project: TerminalProjectListItem) => void;
  onRequestCreateSession: () => void;
  onRequestCloseSession: (terminalSessionId: string) => void;
  onOpenHistoryDrawer: (terminalSessionId: string) => void;
  onCloseProjectDialog: () => void;
  onSubmitProjectDialog: (name: string, projectPath: string) => Promise<void>;
  onConfirmDeleteProject: () => void;
  onProjectDeletionOpenChange: (open: boolean) => void;
  onHistoryDrawerOpenChange: (open: boolean) => void;
  onSessionActivity: (terminalSessionId: string) => void;
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
  loading,
  requestError,
  isMobileMonitor,
  visibleProjects,
  visibleSessions,
  sessions,
  activeProjectId,
  activeProject,
  activeSession,
  previewOpen,
  previewExpanded,
  previewWidthPx,
  previewReservedWidth,
  cachedSurfaceSessionIdSet,
  historyDrawerOpen,
  historyTerminalSessionId,
  historyTerminalName,
  projectDialogMode,
  projectDialogError,
  projectPendingDeletion,
  activityMarkers,
  bellMarkers,
  terminalLayoutVersion,
  onSelectProject,
  onSelectSession,
  onRequestCreateProject,
  onRequestEditProject,
  onRequestDeleteProject,
  onRequestCreateSession,
  onRequestCloseSession,
  onOpenHistoryDrawer,
  onCloseProjectDialog,
  onSubmitProjectDialog,
  onConfirmDeleteProject,
  onProjectDeletionOpenChange,
  onHistoryDrawerOpenChange,
  onSessionActivity,
  onSessionBell,
  onSessionMetadata,
}: TerminalWorkspaceShellProps) {
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
                      onSelectProject(project.projectId);
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
                        onSelectProject(project.projectId);
                        onRequestEditProject(project.projectId);
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                      Edit
                    </ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => {
                        onSelectProject(project.projectId);
                        onRequestDeleteProject(project);
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
              onClick={onRequestCreateProject}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
        {!isMobileMonitor ? (
          <TerminalPreviewMenu
            projectId={activeProjectId}
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
                onOpenHistoryDrawer(activeSession.terminalSessionId);
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
            const isActive = session.terminalSessionId === activeSession?.terminalSessionId;
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
                    onSelectSession(session.terminalSessionId);
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
                      onRequestCloseSession(session.terminalSessionId);
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
              onClick={onRequestCreateSession}
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
                const isActive = session.terminalSessionId === activeSession?.terminalSessionId;
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
                        onSessionActivity(session.terminalSessionId);
                      }}
                      onBell={() => {
                        onSessionBell(session.terminalSessionId);
                      }}
                      onMetadata={(metadata) => {
                        onSessionMetadata(session.terminalSessionId, metadata);
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
                        onSessionActivity(session.terminalSessionId);
                      }}
                      onBell={() => {
                        onSessionBell(session.terminalSessionId);
                      }}
                      onMetadata={(metadata) => {
                        onSessionMetadata(session.terminalSessionId, metadata);
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
                <aside
                  className="flex h-full shrink-0 items-center justify-center border-l border-slate-800 bg-slate-950 text-sm text-slate-400"
                  style={{ width: DEFAULT_TERMINAL_SIDECAR_WIDTH }}
                >
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
                  onRequestEditProject();
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
                      onRequestEditProject();
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
        onClose={onCloseProjectDialog}
        onSubmit={onSubmitProjectDialog}
      />
      <TerminalHistoryDrawer
        open={historyDrawerOpen}
        apiBase={apiBase}
        token={token}
        terminalSessionId={historyTerminalSessionId}
        terminalName={historyTerminalName}
        onOpenChange={onHistoryDrawerOpenChange}
        onAuthExpired={onAuthExpired}
      />
      <AlertDialog
        open={projectPendingDeletion !== null}
        onOpenChange={onProjectDeletionOpenChange}
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
    </section>
  );
}
