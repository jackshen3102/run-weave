import { useMemoizedFn } from "ahooks";
import { memo } from "react";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  EMPTY_TERMINAL_PROJECTS,
  useTerminalProjectsQuery,
} from "../../features/terminal/queries/terminal-workspace-queries";
import { useTerminalAggregateStatus } from "../../features/terminal/use-terminal-aggregate-status";
import { useTerminalWorkspaceStore } from "../../features/terminal/workspace-store";
import { Button } from "../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { SortableTabs, type SortableTabRenderProps } from "../ui/sortable-tabs";
import { TerminalAggregateStatus } from "./terminal-aggregate-status";

interface TerminalProjectTabBarProps {
  isMobileMonitor: boolean;
  loading: boolean;
  onReorderProjects: (fromIndex: number, toIndex: number) => void;
  onRequestCreateProject: () => void;
  onRequestDeleteProject: (project: TerminalProjectListItem) => void;
  onRequestEditProject: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
}

function getProjectId(project: TerminalProjectListItem): string {
  return project.projectId;
}

export const TerminalProjectTabBar = memo(function TerminalProjectTabBar({
  isMobileMonitor,
  loading,
  onReorderProjects,
  onRequestCreateProject,
  onRequestDeleteProject,
  onRequestEditProject,
  onSelectProject,
}: TerminalProjectTabBarProps) {
  const projects = useTerminalProjectsQuery().data ?? EMPTY_TERMINAL_PROJECTS;
  const activeProjectId = useTerminalWorkspaceStore(
    (state) => state.activeParentProjectId,
  );
  const { byParentProjectId } = useTerminalAggregateStatus();

  const renderProjectTab = useMemoizedFn(
    (project: TerminalProjectListItem, sortProps: SortableTabRenderProps) => {
      const isActive = project.projectId === activeProjectId;
      const status = byParentProjectId[project.projectId] ?? 0;

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
              <TerminalAggregateStatus
                label={project.name}
                status={status}
                labelClassName="max-w-[160px] truncate"
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
    },
  );

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <SortableTabs
        items={projects}
        getItemId={getProjectId}
        onReorder={onReorderProjects}
        className="flex min-w-0 items-center gap-1"
        renderTab={renderProjectTab}
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
  );
});
