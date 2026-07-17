import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import {
  Activity,
  ClipboardList,
  ExternalLink,
  Eye,
  History,
  Home,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react";
import { useMemoizedFn } from "ahooks";
import { useState } from "react";
import type { ConnectionConfig } from "../../features/connection/types";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { useTerminalWorkspaceStore } from "../../features/terminal/workspace-store";
import {
  EMPTY_TERMINAL_PROJECTS,
  EMPTY_TERMINAL_SESSIONS,
  useTerminalProjectsQuery,
  useTerminalSessionsQuery,
} from "../../features/terminal/queries/terminal-workspace-queries";
import { useTerminalRuntime } from "../../features/terminal/queries/terminal-runtime-provider";
import { recoverTerminalAgent } from "../../services/terminal";
import { Button } from "../ui/button";
import { ConnectionSwitcher } from "../connection-switcher";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { TerminalProjectTabBar } from "./terminal-project-tab-bar";
import { TerminalQuickInputPopover } from "./terminal-quick-input-popover";

interface HeaderConnectionNavigation {
  connections?: ConnectionConfig[];
  activeConnectionId?: string | null;
  connectionName?: string;
  onSelect?: (connectionId: string) => void;
  onOpenManager?: () => void;
  onNavigateHome?: () => void;
}

interface HeaderProjectCommands {
  onReorderProjects: (fromIndex: number, toIndex: number) => void;
  onSelectProject: (projectId: string) => void;
  requestEditProject: (projectId?: string) => void;
  requestDeleteProject: (project: TerminalProjectListItem) => void;
  requestCreateProject: () => void;
}

interface TerminalWorkspaceHeaderProps {
  connection: HeaderConnectionNavigation;
  loading: boolean;
  isMobileMonitor: boolean;
  projects: HeaderProjectCommands;
}

export function TerminalWorkspaceHeader({
  connection,
  loading,
  isMobileMonitor,
  projects: projectCommands,
}: TerminalWorkspaceHeaderProps) {
  const { apiBase, token } = useTerminalRuntime();
  const {
    activeConnectionId,
    connectionName,
    connections,
    onNavigateHome,
    onOpenManager: onOpenConnectionManager,
    onSelect: onSelectConnection,
  } = connection;
  const {
    onReorderProjects,
    onSelectProject,
    requestEditProject,
    requestDeleteProject,
    requestCreateProject,
  } = projectCommands;
  const projects = useTerminalProjectsQuery().data ?? EMPTY_TERMINAL_PROJECTS;
  const sessions = useTerminalSessionsQuery().data ?? EMPTY_TERMINAL_SESSIONS;
  const activeProjectId = useTerminalWorkspaceStore(
    (state) => state.activeProjectId,
  );
  const activeSessionId = useTerminalWorkspaceStore(
    (state) => state.activeSessionId,
  );
  const activePanelIdBySessionId = useTerminalWorkspaceStore(
    (state) => state.activePanelIdBySessionId,
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
  const setDiagnosticLogOpen = useTerminalWorkspaceStore(
    (state) => state.setDiagnosticLogOpen,
  );
  const setStatusLookupOpen = useTerminalWorkspaceStore(
    (state) => state.setStatusLookupOpen,
  );
  const setRequestError = useTerminalWorkspaceStore(
    (state) => state.setRequestError,
  );
  const bumpAgentRecoveryRevision = useTerminalWorkspaceStore(
    (state) => state.bumpAgentRecoveryRevision,
  );
  const [recoveringAgent, setRecoveringAgent] = useState(false);
  const activeProject =
    projects.find((project) => project.projectId === activeProjectId) ?? null;
  const activeSession =
    sessions.find((session) => session.terminalSessionId === activeSessionId) ??
    null;
  const openHistoryDrawer = (): void => {
    if (!activeSession) return;
    setHistoryTerminalSessionId(activeSession.terminalSessionId);
    setHistoryTerminalPanelId(
      activePanelIdBySessionId[activeSession.terminalSessionId] ??
        activeSession.activePanelId ??
        null,
    );
    setHistoryDrawerOpen(true);
  };
  const recoverActiveAgent = useMemoizedFn(async (): Promise<void> => {
    if (!activeSession || recoveringAgent) {
      return;
    }
    if (
      !window.confirm(
        "Restart the current Codex pane and resume its saved thread? Unsaved prompt text in this pane will be discarded.",
      )
    ) {
      return;
    }
    setRecoveringAgent(true);
    try {
      await recoverTerminalAgent(
        apiBase,
        token,
        activeSession.terminalSessionId,
        { panelId: activeSession.activePanelId },
      );
      bumpAgentRecoveryRevision(activeSession.terminalSessionId);
      setRequestError(null);
    } catch (error) {
      setRequestError(String(error));
    } finally {
      setRecoveringAgent(false);
    }
  });
  return (
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
      <TerminalProjectTabBar
        isMobileMonitor={isMobileMonitor}
        loading={loading}
        onReorderProjects={onReorderProjects}
        onRequestCreateProject={requestCreateProject}
        onRequestDeleteProject={requestDeleteProject}
        onRequestEditProject={requestEditProject}
        onSelectProject={onSelectProject}
      />
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
              onSelect={() => {
                const browserBaseUrl = ["http:", "https:"].includes(
                  window.location.protocol,
                )
                  ? window.location.origin
                  : apiBase;
                const url = new URL(
                  "/prototypes",
                  browserBaseUrl || window.location.origin,
                );
                if (activeProjectId) {
                  url.searchParams.set("project", activeProjectId);
                }
                if (window.electronAPI?.openExternal) {
                  void window.electronAPI.openExternal(url.toString());
                  return;
                }
                window.open(url.toString(), "_blank", "noopener,noreferrer");
              }}
            >
              <ExternalLink className="h-4 w-4" />
              Open Prototypes
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!activeSession?.terminalSessionId}
              onSelect={() => {
                if (activeSession?.terminalSessionId) {
                  openHistoryDrawer();
                }
              }}
            >
              <History className="h-4 w-4" />
              Terminal History
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={
                recoveringAgent ||
                activeSession?.terminalState?.state !== "agent_idle" ||
                activeSession.terminalState.agent !== "codex"
              }
              onSelect={() => {
                void recoverActiveAgent();
              }}
            >
              <RefreshCw className="h-4 w-4" />
              {recoveringAgent ? "Recovering Codex…" : "Recover Codex"}
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
  );
}
