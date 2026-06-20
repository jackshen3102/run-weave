import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
} from "react";
import { createPortal } from "react-dom";
import type {
  TerminalProjectListItem,
  TerminalSessionListItem,
  TerminalState,
} from "@runweave/shared";
import {
  History,
  Home,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import type { ConnectionConfig } from "../../features/connection/types";
import {
  DEFAULT_TERMINAL_SIDECAR_WIDTH,
  useTerminalPreviewStore,
} from "../../features/terminal/preview-store";
import type { ClientMode } from "../../features/client-mode";
import { formatTerminalSessionName } from "../../features/terminal/session-name";
import { Button } from "../ui/button";
import { ShimmerText } from "../ui/shimmer-text";
import {
  SortableTabs,
  type SortableTabRenderProps,
} from "../ui/sortable-tabs";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { DiagnosticLogEntry } from "../diagnostic-log-entry";
import { TerminalHistoryDrawer } from "./terminal-history-drawer";
import { TerminalPreviewMenu } from "./terminal-preview-menu";
import { TerminalProjectDialog } from "./terminal-project-dialog";
import { TerminalSubmitPopover } from "./terminal-submit-popover";
import { TerminalHeadlessConnection } from "./terminal-headless-connection";
import { TerminalSurface } from "./terminal-surface";

const TerminalPreviewPanel = lazy(() =>
  import("./terminal-preview-panel").then((module) => ({
    default: module.TerminalPreviewPanel,
  })),
);

function getTerminalStateLabel(
  session: TerminalSessionListItem,
  terminalState?: TerminalState,
): string {
  if (session.status === "exited") {
    return "Exited";
  }
  if (!terminalState) {
    return "Status unavailable";
  }
  if (terminalState.state === "agent_running") {
    return "Agent running";
  }
  if (terminalState.state === "agent_idle") {
    return "Agent idle";
  }
  return "Shell idle";
}

function getTerminalStateDetail(
  session: TerminalSessionListItem,
  terminalState?: TerminalState,
): string {
  if (session.status === "exited") {
    return "Terminal exited";
  }
  if (!terminalState) {
    return "Waiting for state";
  }
  if (terminalState.state === "agent_running") {
    return "Model response in progress";
  }
  if (terminalState.state === "agent_idle") {
    return "Waiting for input";
  }
  return "Shell ready";
}

function formatCommandForDisplay(session: TerminalSessionListItem): string {
  const command = session.activeCommand?.trim() || session.command.trim();
  if (!command) {
    return "-";
  }
  const args = session.activeCommand?.trim() ? [] : session.args;
  return [command, ...args].join(" ");
}

function formatActivityTime(value: string | undefined): string {
  if (!value) {
    return "-";
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return "Just now";
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function TerminalTabStateDot({
  session,
  terminalState,
}: {
  session: TerminalSessionListItem;
  terminalState?: TerminalState;
}) {
  if (session.status === "exited") {
    return (
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full border border-slate-600 bg-slate-800"
      />
    );
  }
  if (!terminalState) {
    return null;
  }
  if (terminalState.state === "agent_running") {
    return (
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full border border-cyan-200 bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.75)] motion-safe:animate-pulse"
      />
    );
  }
  if (terminalState.state === "agent_idle") {
    return (
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full bg-sky-500"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="h-2 w-2 shrink-0 rounded-full border border-slate-500 bg-transparent"
    />
  );
}

function TerminalTabStateCard({
  session,
  terminalState,
}: {
  session: TerminalSessionListItem;
  terminalState?: TerminalState;
}) {
  const stateLabel = getTerminalStateLabel(session, terminalState);
  const detail = getTerminalStateDetail(session, terminalState);
  return (
    <div className="space-y-2 text-xs text-slate-300">
      <div className="flex items-center gap-2">
        <TerminalTabStateDot session={session} terminalState={terminalState} />
        <div className="min-w-0">
          <div className="font-medium text-slate-100">{stateLabel}</div>
          <div className="truncate text-slate-400">{detail}</div>
        </div>
      </div>
      <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-x-2 gap-y-1">
        <span className="text-slate-500">Agent</span>
        <span className="truncate text-slate-200">
          {terminalState?.agent ?? "-"}
        </span>
        <span className="text-slate-500">Command</span>
        <span className="truncate text-slate-200">
          {formatCommandForDisplay(session)}
        </span>
        <span className="text-slate-500">Activity</span>
        <span className="truncate text-slate-200">
          {formatActivityTime(session.lastActivityAt)}
        </span>
      </div>
    </div>
  );
}

function TerminalSessionTab({
  session,
  isActive,
  isDragging,
  isMobileMonitor,
  hasBell,
  hasCompletion,
  terminalState,
  onSelectSession,
  onRequestCloseSession,
  onRequestEditAlias,
}: {
  session: TerminalSessionListItem;
  isActive: boolean;
  isDragging: boolean;
  isMobileMonitor: boolean;
  hasBell: boolean;
  hasCompletion: boolean;
  terminalState?: TerminalState;
  onSelectSession: (terminalSessionId: string) => void;
  onRequestCloseSession: (terminalSessionId: string) => void;
  onRequestEditAlias: (session: TerminalSessionListItem) => void;
}) {
  const tabRef = useRef<HTMLDivElement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsPosition, setDetailsPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const displayName = formatTerminalSessionName({
    alias: session.alias,
    cwd: session.cwd,
    activeCommand: session.activeCommand,
  });
  const isWorking = terminalState?.state === "agent_running";
  const showStateDetails =
    !isMobileMonitor && (Boolean(terminalState) || session.status === "exited");
  const openDetails = (): void => {
    if (showStateDetails) {
      const rect = tabRef.current?.getBoundingClientRect();
      if (rect) {
        setDetailsPosition({
          left: Math.min(rect.left, window.innerWidth - 272),
          top: rect.bottom + 4,
        });
      }
      setDetailsOpen(true);
    }
  };
  const closeDetailsOnBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const relatedTarget = event.relatedTarget;
    if (
      relatedTarget instanceof Node &&
      event.currentTarget.contains(relatedTarget)
    ) {
      return;
    }
    setDetailsOpen(false);
  };

  const tab = (
    <div
      ref={tabRef}
      onMouseEnter={openDetails}
      onPointerEnter={openDetails}
      onMouseLeave={() => {
        setDetailsOpen(false);
      }}
      onPointerLeave={() => {
        setDetailsOpen(false);
      }}
      onFocusCapture={openDetails}
      onBlurCapture={closeDetailsOnBlur}
      className={[
        "relative flex h-full shrink-0 items-center gap-2 border-r border-slate-800 pl-2 pr-3",
        isDragging
          ? "bg-sky-500/20 text-slate-50 opacity-90"
          : isActive
            ? "overflow-hidden bg-slate-900/35 text-slate-50 before:absolute before:inset-x-0 before:bottom-0 before:h-0.5 before:bg-sky-500"
        : "text-slate-300 hover:bg-slate-900/45 hover:text-slate-100",
      ].join(" ")}
    >
      <button
        type="button"
        aria-label={displayName}
        data-terminal-session-id={session.terminalSessionId}
        className={[
          "inline-flex h-full min-w-0 max-w-[220px] items-center gap-1.5 py-0 text-xs",
          isActive ? "text-slate-50" : "text-slate-200",
        ].join(" ")}
        onMouseEnter={openDetails}
        onPointerEnter={openDetails}
        onFocus={openDetails}
        onClick={() => {
          onSelectSession(session.terminalSessionId);
        }}
      >
        {isWorking ? (
          <ShimmerText
            className="truncate shimmer-invert"
            style={{
              "--shimmer-duration": "4000",
              "--shimmer-repeat-delay": "300",
            } as CSSProperties}
          >
            {displayName}
          </ShimmerText>
        ) : (
          <span className="truncate">{displayName}</span>
        )}
        <span
          aria-hidden="true"
          className={[
            "h-1.5 w-1.5 shrink-0 rounded-full",
            hasBell
              ? "bg-amber-400"
              : hasCompletion
                ? "bg-emerald-400"
                : "bg-transparent",
          ].join(" ")}
        />
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

  const detailsCard =
    showStateDetails && detailsOpen && detailsPosition
      ? createPortal(
          <div
            className="pointer-events-none z-50 w-64 rounded-md border border-slate-700 bg-slate-950/95 p-3 text-slate-100 shadow-xl"
            style={{
              position: "fixed",
              left: detailsPosition.left,
              top: detailsPosition.top,
            }}
          >
            <TerminalTabStateCard
              session={session}
              terminalState={terminalState}
            />
          </div>,
          document.body,
        )
      : null;

  if (isMobileMonitor) {
    return tab;
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{tab}</ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem
            onSelect={() => {
              onRequestEditAlias(session);
            }}
          >
            <Pencil className="h-4 w-4" />
            Rename Alias
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {detailsCard}
    </>
  );
}

function TerminalSessionAliasDialog({
  open,
  loading,
  session,
  onClose,
  onSubmit,
}: {
  open: boolean;
  loading: boolean;
  session: TerminalSessionListItem | null;
  onClose: () => void;
  onSubmit: (alias: string) => Promise<void>;
}) {
  const [alias, setAlias] = useState("");

  useEffect(() => {
    if (!open) {
      return;
    }
    setAlias(session?.alias ?? "");
  }, [open, session?.alias]);

  if (!open || !session) {
    return null;
  }

  const fallbackName = formatTerminalSessionName({
    cwd: session.cwd,
    activeCommand: session.activeCommand,
  });
  const submit = async (): Promise<void> => {
    await onSubmit(alias);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !loading) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename Terminal</DialogTitle>
          <DialogDescription className="truncate">
            {fallbackName}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="terminal-alias">Alias</Label>
          <Input
            id="terminal-alias"
            value={alias}
            maxLength={80}
            autoFocus
            placeholder="coder"
            onChange={(event) => setAlias(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <p className="text-xs text-muted-foreground">
            Leave empty to use the default terminal name.
          </p>
        </div>
        <DialogFooter>
          <Button
            type="button"
            disabled={loading}
            onClick={() => {
              void submit();
            }}
          >
            {loading ? "Saving..." : "Save Alias"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
  completionMarkers: Record<string, boolean>;
  bellMarkers: Record<string, boolean>;
  terminalStateBySessionId: Record<string, TerminalState>;
  terminalLayoutVersion: string;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (terminalSessionId: string) => void;
  onRequestCreateProject: () => void;
  onRequestEditProject: (projectId?: string) => void;
  onRequestDeleteProject: (project: TerminalProjectListItem) => void;
  onRequestCreateSession: () => void;
  onRequestCloseSession: (terminalSessionId: string) => void;
  onSubmitSessionAlias: (
    terminalSessionId: string,
    alias: string,
  ) => Promise<void>;
  onOpenHistoryDrawer: (terminalSessionId: string) => void;
  onCloseProjectDialog: () => void;
  onSubmitProjectDialog: (name: string, projectPath: string) => Promise<void>;
  onConfirmDeleteProject: () => void;
  onProjectDeletionOpenChange: (open: boolean) => void;
  onHistoryDrawerOpenChange: (open: boolean) => void;
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
  completionMarkers,
  bellMarkers,
  terminalStateBySessionId,
  terminalLayoutVersion,
  onSelectProject,
  onSelectSession,
  onRequestCreateProject,
  onRequestEditProject,
  onRequestDeleteProject,
  onRequestCreateSession,
  onRequestCloseSession,
  onSubmitSessionAlias,
  onOpenHistoryDrawer,
  onCloseProjectDialog,
  onSubmitProjectDialog,
  onConfirmDeleteProject,
  onProjectDeletionOpenChange,
  onHistoryDrawerOpenChange,
  onReorderProjects,
  onReorderSessions,
  onSessionBell,
  onSessionMetadata,
}: TerminalWorkspaceShellProps) {
  const [aliasTarget, setAliasTarget] =
    useState<TerminalSessionListItem | null>(null);
  const [diagnosticLogOpen, setDiagnosticLogOpen] = useState(false);

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
          <SortableTabs
            items={visibleProjects}
            getItemId={(project) => project.projectId}
            onReorder={onReorderProjects}
            className="flex min-w-0 items-center gap-1"
            renderTab={(project: TerminalProjectListItem, sortProps: SortableTabRenderProps) => {
              const isActive = project.projectId === activeProjectId;
              const hasBell = sessions.some(
                (s) =>
                  s.projectId === project.projectId &&
                  bellMarkers[s.terminalSessionId],
              );
              const hasCompletion = sessions.some(
                (s) =>
                  s.projectId === project.projectId &&
                  completionMarkers[s.terminalSessionId],
              );
              const isWorking = sessions.some(
                (s) =>
                  s.projectId === project.projectId &&
                  terminalStateBySessionId[s.terminalSessionId]?.state ===
                    "agent_running",
              );
              return (
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      aria-pressed={isActive}
                      className={[
                        "inline-flex h-6 shrink-0 items-center gap-2 rounded-md border px-3 text-xs transition-colors",
                        sortProps.isDragging
                          ? "border-sky-500/60 bg-sky-500/20 text-slate-50 opacity-90"
                          : isActive
                            ? "border-sky-700/70 bg-slate-800 text-slate-50 shadow-[inset_0_1px_0_rgba(148,163,184,0.18)]"
                            : "border-slate-800 bg-slate-900/90 text-slate-200 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                      ].join(" ")}
                      onClick={() => {
                        onSelectProject(project.projectId);
                      }}
                      title={project.name}
                    >
                      {isWorking ? (
                        <ShimmerText
                          className="max-w-[160px] truncate shimmer-invert"
                          style={{
                            "--shimmer-duration": "4000",
                            "--shimmer-repeat-delay": "300",
                          } as CSSProperties}
                        >
                          {project.name}
                        </ShimmerText>
                      ) : (
                        <span className="max-w-[160px] truncate">
                          {project.name}
                        </span>
                      )}
                      <span
                        aria-hidden="true"
                        className={[
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          hasBell
                            ? "bg-amber-400"
                            : hasCompletion
                              ? "bg-emerald-400"
                              : "bg-transparent",
                        ].join(" ")}
                      />
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
            }}
          />
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
          <TerminalSubmitPopover
            apiBase={apiBase}
            token={token}
            activeProject={activeProject}
            activeSession={activeSession}
            disabled={loading}
          />
        ) : null}
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
            disabled={loading || !activeProjectId}
            aria-label="Open Orchestrator"
            title="Open Orchestrator"
            className="h-6 w-6 shrink-0 rounded-md px-0 text-slate-300 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40"
            onClick={() => {
              useTerminalPreviewStore.getState().openOrchestrator();
            }}
          >
            <Workflow className="h-3.5 w-3.5" />
          </Button>
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
        {!isMobileMonitor ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="More actions"
                title="More actions"
                className="h-6 w-6 shrink-0 rounded-md px-0 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem
                onSelect={() => {
                  setDiagnosticLogOpen(true);
                }}
              >
                日志上报
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <div className="flex h-[26px] items-stretch border-b border-slate-800">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <SortableTabs
            items={visibleSessions}
            getItemId={(session) => session.terminalSessionId}
            onReorder={onReorderSessions}
            className="flex min-w-0 items-stretch"
            renderTab={(session: TerminalSessionListItem, sortProps: SortableTabRenderProps) => {
              const isActive = session.terminalSessionId === activeSession?.terminalSessionId;
              const hasBell =
                !isActive && Boolean(bellMarkers[session.terminalSessionId]);
              const hasCompletion = Boolean(
                completionMarkers[session.terminalSessionId],
              );
              return (
                <TerminalSessionTab
                  session={session}
                  isActive={isActive}
                  isDragging={sortProps.isDragging}
                  isMobileMonitor={isMobileMonitor}
                  hasBell={hasBell}
                  hasCompletion={hasCompletion}
                  terminalState={terminalStateBySessionId[session.terminalSessionId]}
                  onSelectSession={onSelectSession}
                  onRequestCloseSession={onRequestCloseSession}
                  onRequestEditAlias={setAliasTarget}
                />
              );
            }}
          />
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
                activeSession={activeSession}
                widthPx={previewWidthPx}
                onAuthExpired={onAuthExpired}
                sessions={sessions}
                onSelectSession={onSelectSession}
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
                    activeSession={activeSession}
                    widthPx={previewWidthPx}
                    onAuthExpired={onAuthExpired}
                    sessions={sessions}
                    onSelectSession={onSelectSession}
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
      <TerminalSessionAliasDialog
        open={aliasTarget !== null}
        loading={loading}
        session={aliasTarget}
        onClose={() => {
          if (!loading) {
            setAliasTarget(null);
          }
        }}
        onSubmit={async (alias) => {
          if (!aliasTarget) {
            return;
          }
          await onSubmitSessionAlias(aliasTarget.terminalSessionId, alias);
          setAliasTarget(null);
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
