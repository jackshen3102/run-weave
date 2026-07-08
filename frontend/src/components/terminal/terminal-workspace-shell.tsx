import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
} from "react";
import { createPortal } from "react-dom";
import { useMemoizedFn } from "ahooks";
import type {
  TerminalPanelWorkspace,
  TerminalProjectListItem,
  TerminalSessionListItem,
  TerminalState,
} from "@runweave/shared";
import {
  ClipboardList,
  Activity,
  Eye,
  History,
  Home,
  MoreHorizontal,
  PanelsTopLeft,
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
import { useTerminalWorkspaceStore } from "../../features/terminal/workspace-store";
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
import { TerminalQuickInputPopover } from "./terminal-quick-input-popover";
import { TerminalStatusLookupDialog } from "./terminal-status-lookup-dialog";
import { TerminalProjectDialog } from "./terminal-project-dialog";
import { TerminalHeadlessConnection } from "./terminal-headless-connection";
import { TerminalSurface } from "./terminal-surface";
import { TerminalPanelTargetBar } from "./terminal-panel-target-bar";
import {
  getAgentTeamRunForTerminal,
  listTerminalPanels,
  resizeTerminalPanel,
  updateTerminalSession,
} from "../../services/terminal";
import { HttpError } from "../../services/http";

function getWorkspacePanelCount(
  workspace: { panels?: unknown[] } | null | undefined,
): number | null {
  return Array.isArray(workspace?.panels) ? workspace.panels.length : null;
}

function formatHistoryPanelLabel(
  panel: TerminalPanelWorkspace["panels"][number],
): string {
  return panel.alias || panel.role || panel.panelId.slice(0, 8);
}

function resolveHistoryPanelId(
  workspace: TerminalPanelWorkspace | null,
  activePanelId: string | null,
): string | null {
  if (!workspace) {
    return null;
  }
  return (
    workspace.panels.find((panel) => panel.panelId === activePanelId)?.panelId ??
    workspace.panels.find((panel) => panel.panelId === workspace.activePanelId)
      ?.panelId ??
    workspace.panels.find((panel) => panel.focused)?.panelId ??
    workspace.panels[0]?.panelId ??
    null
  );
}

const TerminalPreviewPanel = lazy(() =>
  import("./terminal-preview-panel").then((module) => ({
    default: module.TerminalPreviewPanel,
  })),
);

const HEADLESS_TERMINAL_CONNECTION_DELAY_MS = 1_500;
const MAX_HEADLESS_TERMINAL_CONNECTIONS = 4;

function parseTerminalActivityTime(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

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
  if (terminalState.state === "agent_starting") {
    return "Agent starting";
  }
  if (terminalState.state === "agent_idle") {
    return "Agent idle";
  }
  return "Shell idle";
}

function canOpenAgentTeamForSession(
  session: TerminalSessionListItem | null,
): boolean {
  return Boolean(
    session &&
      session.status === "running" &&
      (session.tmuxSessionName ||
        session.activePanelId ||
        (session.panelCount ?? 0) > 0),
  );
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
  if (terminalState.state === "agent_starting") {
    return "Starting agent";
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
  if (terminalState.state === "agent_starting") {
    return (
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full border border-amber-200 bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.55)] motion-safe:animate-pulse"
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
  panelSplitEnabled,
  panelCount,
  onSelectSession,
  onRequestCloseSession,
  onRequestEditAlias,
  onPanelSplitEnabledChange,
  agentTeamAvailable,
  onRequestAgentTeam,
}: {
  session: TerminalSessionListItem;
  isActive: boolean;
  isDragging: boolean;
  isMobileMonitor: boolean;
  hasBell: boolean;
  hasCompletion: boolean;
  terminalState?: TerminalState;
  panelSplitEnabled: boolean;
  panelCount: number;
  onSelectSession: (terminalSessionId: string) => void;
  onRequestCloseSession: (terminalSessionId: string) => void;
  onRequestEditAlias: (session: TerminalSessionListItem) => void;
  onPanelSplitEnabledChange: (enabled: boolean) => void;
  agentTeamAvailable: boolean;
  onRequestAgentTeam: (terminalSessionId: string) => void;
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
  const disablePanelSplitToggle = panelSplitEnabled && panelCount > 1;
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
        <ContextMenuContent className="w-48">
          <ContextMenuItem
            className="gap-2"
            onSelect={() => {
              onRequestEditAlias(session);
            }}
          >
            <Pencil className="h-4 w-4" />
            Rename Alias
          </ContextMenuItem>
          <ContextMenuItem
            aria-disabled={disablePanelSplitToggle ? true : undefined}
            className={[
              "gap-2",
              disablePanelSplitToggle
                ? "text-muted-foreground opacity-50 focus:bg-transparent focus:text-muted-foreground"
                : "",
            ].join(" ")}
            title={
              disablePanelSplitToggle
                ? "Close extra panels before disabling panel split."
                : undefined
            }
            onSelect={(event) => {
              if (disablePanelSplitToggle) {
                event.preventDefault();
                return;
              }
              onPanelSplitEnabledChange(!panelSplitEnabled);
            }}
          >
            <PanelsTopLeft className="h-4 w-4" />
            {panelSplitEnabled ? "Disable Panel Split" : "Enable Panel Split"}
          </ContextMenuItem>
          {agentTeamAvailable ? (
            <ContextMenuItem
              className="gap-2"
              onSelect={() => {
                onRequestAgentTeam(session.terminalSessionId);
              }}
            >
              <Workflow className="h-4 w-4" />
              Agent Team
            </ContextMenuItem>
          ) : null}
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
  const [activeAgentTeamRunSessionId, setActiveAgentTeamRunSessionId] =
    useState<string | null>(null);
  const [pendingAgentTeamSessionId, setPendingAgentTeamSessionId] = useState<
    string | null
  >(null);
  const [headlessConnectionsEnabled, setHeadlessConnectionsEnabled] =
    useState(false);
  const autoOpenedAgentTeamSessionIdRef = useRef<string | null>(null);
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
    visibleSessions.find(
      (session) => session.terminalSessionId === activeSessionId,
    ) ??
    visibleSessions[0] ??
    null;
  const activeAgentTeamRunPresent = Boolean(
    activeSession &&
      activeAgentTeamRunSessionId === activeSession.terminalSessionId,
  );
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
  const activeAgentTeamAvailable = canOpenAgentTeamForSession(activeSession);
  const showAgentTeamTool = Boolean(
    activeProject &&
      activeSession &&
      (activeAgentTeamRunPresent ||
        pendingAgentTeamSessionId === activeSession.terminalSessionId ||
        (panelSplitEnabled && activeAgentTeamAvailable)),
  );

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

  const requestAgentTeam = useMemoizedFn((terminalSessionId: string): void => {
    onSelectSession(terminalSessionId);
    setPendingAgentTeamSessionId(terminalSessionId);
    void setPanelSplitEnabled(terminalSessionId, true).then((updatedSession) => {
      if (!updatedSession) {
        setPendingAgentTeamSessionId((current) =>
          current === terminalSessionId ? null : current,
        );
        return;
      }
      useTerminalPreviewStore.getState().openAgentTeam();
    });
  });

  const syncActiveAgentTeamRunForActiveSession = useMemoizedFn(
    (active: boolean): void => {
      const terminalSessionId = activeSession?.terminalSessionId ?? null;
      setActiveAgentTeamRunSessionId(active ? terminalSessionId : null);
    },
  );

  useEffect(() => {
    const terminalSessionId = activeSession?.terminalSessionId ?? null;
    if (!terminalSessionId) {
      autoOpenedAgentTeamSessionIdRef.current = null;
      return;
    }
    if (!activeAgentTeamRunPresent || !showAgentTeamTool) {
      if (autoOpenedAgentTeamSessionIdRef.current === terminalSessionId) {
        autoOpenedAgentTeamSessionIdRef.current = null;
      }
      return;
    }
    if (autoOpenedAgentTeamSessionIdRef.current === terminalSessionId) {
      return;
    }
    autoOpenedAgentTeamSessionIdRef.current = terminalSessionId;
    useTerminalPreviewStore.getState().openAgentTeam();
  }, [
    activeAgentTeamRunPresent,
    activeSession?.terminalSessionId,
    showAgentTeamTool,
  ]);

  useEffect(() => {
    if (!pendingAgentTeamSessionId) {
      return;
    }
    if (
      activeSession?.terminalSessionId === pendingAgentTeamSessionId &&
      (panelSplitEnabled || activeAgentTeamRunPresent)
    ) {
      setPendingAgentTeamSessionId(null);
    }
  }, [
    activeAgentTeamRunPresent,
    activeSession?.terminalSessionId,
    panelSplitEnabled,
    pendingAgentTeamSessionId,
  ]);

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

  useEffect(() => {
    if (!activeProject?.projectId || !activeSession?.terminalSessionId) {
      setActiveAgentTeamRunSessionId(null);
      return;
    }
    let cancelled = false;
    const terminalSessionId = activeSession.terminalSessionId;
    setActiveAgentTeamRunSessionId(null);
    void getAgentTeamRunForTerminal(
      apiBase,
      token,
      activeProject.projectId,
      terminalSessionId,
    )
      .then((run) => {
        if (cancelled) {
          return;
        }
        setActiveAgentTeamRunSessionId(
          run && run.status !== "done" && run.status !== "failed"
            ? terminalSessionId
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) {
          setActiveAgentTeamRunSessionId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeProject?.projectId,
    activeSession?.terminalSessionId,
    apiBase,
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
                          requestEditProject(project.projectId);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                        Edit
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => {
                          onSelectProject(project.projectId);
                          requestDeleteProject(project);
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
              onClick={requestCreateProject}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
        {!isMobileMonitor ? (
          <TerminalQuickInputPopover
            apiBase={apiBase}
            token={token}
            activeProject={activeProject}
            activeSession={activeSession}
            disabled={loading}
          />
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
                disabled={loading || !activeProjectId}
                onSelect={() => {
                  if (activeProjectId) {
                    useTerminalPreviewStore
                      .getState()
                      .openPreview(activeProjectId);
                  }
                }}
              >
                <Eye className="h-4 w-4" />
                Preview
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!activeSession?.terminalSessionId}
                onSelect={() => {
                  if (activeSession?.terminalSessionId) {
                    openHistoryDrawer(
                      activeSession.terminalSessionId,
                      activeHistoryPanelId,
                    );
                  }
                }}
              >
                <History className="h-4 w-4" />
                Terminal History
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setDiagnosticLogOpen(true);
                }}
              >
                <ClipboardList className="h-4 w-4" />
                日志上报
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setStatusLookupOpen(true);
                }}
              >
                <Activity className="h-4 w-4" />
                状态查询
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
                  panelSplitEnabled={session.panelSplitEnabled}
                  panelCount={
                    getWorkspacePanelCount(
                      panelWorkspaceBySessionId[session.terminalSessionId],
                    ) ??
                    session.panelCount ??
                    1
                  }
                  onSelectSession={onSelectSession}
                  onRequestCloseSession={onRequestCloseSession}
                  onRequestEditAlias={setAliasTarget}
                  onPanelSplitEnabledChange={(enabled) => {
                    void setPanelSplitEnabled(
                      session.terminalSessionId,
                      enabled,
                    );
                  }}
                  agentTeamAvailable={canOpenAgentTeamForSession(session)}
                  onRequestAgentTeam={requestAgentTeam}
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
          <div className="flex min-h-0 flex-1 flex-col">
            {activeSession && !isMobileMonitor && panelSplitEnabled ? (
              <TerminalPanelTargetBar
                apiBase={apiBase}
                token={token}
                activeSession={activeSession}
                workspace={activePanelWorkspace}
                onWorkspaceChange={(workspace) => {
                  setPanelWorkspaceBySessionId((current) => ({
                    ...current,
                    [workspace.terminalSessionId]: workspace,
                  }));
                  setActivePanelIdBySessionId((current) => ({
                    ...current,
                    [workspace.terminalSessionId]: workspace.activePanelId,
                  }));
                }}
              />
            ) : null}
            <div className="relative min-h-0 flex-1">
              {visibleSessions.length > 0 ? (
                <>
                  {headlessSessions.map((session) => (
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
                  ))}
                  {surfaceSessions.map((session) => {
                    const isActive =
                      session.terminalSessionId ===
                      activeSession?.terminalSessionId;

                    return (
                      <div
                        aria-hidden={!isActive}
                        className={[
                          "absolute top-0 h-full w-full",
                          isActive
                            ? "left-0"
                            : "-left-[9999em] pointer-events-none",
                        ].join(" ")}
                        key={`${apiBase}:${session.terminalSessionId}:surface`}
                      >
                        <TerminalSurface
                          active={isActive}
                          activeCommand={session.activeCommand}
                          apiBase={apiBase}
                          clientMode={clientMode}
                          layoutVersion={terminalLayoutVersion}
                          sessionStatus={session.status}
                          terminalSessionId={session.terminalSessionId}
                          terminalState={
                            terminalStateBySessionId[
                              session.terminalSessionId
                            ] ?? session.terminalState
                          }
                          token={token}
                          paneWorkspace={
                            session.panelSplitEnabled
                              ? panelWorkspaceBySessionId[
                                  session.terminalSessionId
                                ] ?? null
                              : null
                          }
                          onResizePane={
                            !isMobileMonitor && session.panelSplitEnabled
                              ? (panelId, direction, cells) => {
                                  void resizePanel(
                                    session.terminalSessionId,
                                    panelId,
                                    direction,
                                    cells,
                                  );
                                }
                              : undefined
                          }
                          onAuthExpired={onAuthExpired}
                          onBell={() => {
                            onSessionBell(session.terminalSessionId);
                          }}
                          onViewportResize={
                            session.panelSplitEnabled
                              ? () => {
                                  void refreshPanelWorkspace(
                                    session.terminalSessionId,
                                  );
                                }
                              : undefined
                          }
                          onMetadata={(metadata) => {
                            onSessionMetadata(
                              session.terminalSessionId,
                              metadata,
                            );
                          }}
                        />
                      </div>
                    );
                  })}
                </>
              ) : (
                <div className="flex h-full items-center justify-center px-6 text-sm text-slate-400">
                  No terminal tab yet. Create one to start.
                </div>
              )}
            </div>
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
                showAgentTeamTool={showAgentTeamTool}
                widthPx={previewWidthPx}
                onAuthExpired={onAuthExpired}
                sessions={sessions}
                onSelectSession={onSelectSession}
                onPanelSplitEnabledChange={(enabled) => {
                  if (activeSession) {
                    void setPanelSplitEnabled(
                      activeSession.terminalSessionId,
                      enabled,
                    );
                  }
                }}
                onActiveAgentTeamRunChange={
                  syncActiveAgentTeamRunForActiveSession
                }
                onEditProject={() => {
                  requestEditProject();
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
                    showAgentTeamTool={showAgentTeamTool}
                    widthPx={previewWidthPx}
                    onAuthExpired={onAuthExpired}
                    sessions={sessions}
                    onSelectSession={onSelectSession}
                    onPanelSplitEnabledChange={(enabled) => {
                      if (activeSession) {
                        void setPanelSplitEnabled(
                          activeSession.terminalSessionId,
                          enabled,
                        );
                      }
                    }}
                    onActiveAgentTeamRunChange={
                      syncActiveAgentTeamRunForActiveSession
                    }
                    onEditProject={() => {
                      requestEditProject();
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
          setHistoryDrawerOpen(open);
          if (!open) {
            setHistoryTerminalSessionId(null);
            setHistoryTerminalPanelId(null);
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
