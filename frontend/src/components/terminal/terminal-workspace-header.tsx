import type { CSSProperties } from "react";
import type {
  TerminalProjectListItem,
  TerminalSessionListItem,
  TerminalState,
} from "@runweave/shared";
import {
  Activity,
  ClipboardList,
  Eye,
  History,
  Home,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type { ConnectionConfig } from "../../features/connection/types";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { Button } from "../ui/button";
import { ShimmerText } from "../ui/shimmer-text";
import {
  SortableTabs,
  type SortableTabRenderProps,
} from "../ui/sortable-tabs";
import { ConnectionSwitcher } from "../connection-switcher";
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
  visibleProjects: TerminalProjectListItem[];
  activeProjectId: string | null;
  sessions: TerminalSessionListItem[];
  completionMarkers: Record<string, boolean | undefined>;
  bellMarkers: Record<string, boolean | undefined>;
  terminalStateBySessionId: Record<string, TerminalState | undefined>;
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
  visibleProjects,
  activeProjectId,
  sessions,
  completionMarkers,
  bellMarkers,
  terminalStateBySessionId,
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
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <SortableTabs
          items={visibleProjects}
          getItemId={(project) => project.projectId}
          onReorder={onReorderProjects}
          className="flex min-w-0 items-center gap-1"
          renderTab={(
            project: TerminalProjectListItem,
            sortProps: SortableTabRenderProps,
          ) => {
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
  );
}
