import type {
  TerminalProjectListItem,
  TerminalSessionListItem,
} from "@runweave/shared";
import {
  Activity,
  ClipboardList,
  Eye,
  GalleryVerticalEnd,
  History,
  Home,
  MoreHorizontal,
} from "lucide-react";
import type { ConnectionConfig } from "../../features/connection/types";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
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

interface TerminalWorkspaceHeaderProps {
  apiBase: string;
  token: string;
  loading: boolean;
  isMobileMonitor: boolean;
  connections?: ConnectionConfig[];
  activeConnectionId?: string | null;
  connectionName?: string;
  onSelectConnection?: (connectionId: string) => void;
  onOpenConnectionManager?: () => void;
  onNavigateHome?: () => void;
  activeProjectId: string | null;
  onReorderProjects: (fromIndex: number, toIndex: number) => void;
  onSelectProject: (projectId: string) => void;
  requestEditProject: (projectId?: string) => void;
  requestDeleteProject: (project: TerminalProjectListItem) => void;
  requestCreateProject: () => void;
  activeProject: TerminalProjectListItem | null;
  activeSession: TerminalSessionListItem | null;
  openHistoryDrawer: (
    terminalSessionId: string,
    terminalPanelId?: string | null,
  ) => void;
  activeHistoryPanelId: string | null;
  setDiagnosticLogOpen: (open: boolean) => void;
  setStatusLookupOpen: (open: boolean) => void;
}

export function TerminalWorkspaceHeader({
  apiBase,
  token,
  loading,
  isMobileMonitor,
  connections,
  activeConnectionId,
  connectionName,
  onSelectConnection,
  onOpenConnectionManager,
  onNavigateHome,
  activeProjectId,
  onReorderProjects,
  onSelectProject,
  requestEditProject,
  requestDeleteProject,
  requestCreateProject,
  activeProject,
  activeSession,
  openHistoryDrawer,
  activeHistoryPanelId,
  setDiagnosticLogOpen,
  setStatusLookupOpen,
}: TerminalWorkspaceHeaderProps) {
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
              disabled={loading}
              onSelect={() => {
                useTerminalPreviewStore.getState().openPrototypes();
              }}
            >
              <GalleryVerticalEnd className="h-4 w-4" />
              Prototypes
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
  );
}
