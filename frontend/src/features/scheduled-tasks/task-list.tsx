import type { ScheduledTask } from "@runweave/shared/scheduled-tasks";
import { CalendarClock } from "lucide-react";
import { useTerminalProjectsQuery } from "../terminal/queries/workspace";
import { parseTerminalChildProjectId } from "@runweave/shared/terminal/project-context";
import { displayTime, scheduleLabel } from "./presentation";
import { TaskActions } from "./task-actions";

export function TaskList({
  tasks,
  onOpen,
  onEdit,
  readOnly = false,
}: {
  tasks: ScheduledTask[];
  readOnly?: boolean;
  onOpen: (taskId: string) => void;
  onEdit: (task: ScheduledTask) => void;
}) {
  const projects = useTerminalProjectsQuery().data;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {tasks.map((task) => {
        const child = parseTerminalChildProjectId(task.projectId);
        const project = projects?.find(
          (item) =>
            item.projectId === (child?.parentProjectId ?? task.projectId),
        );
        return (
          <article
            key={task.id}
            className="min-w-0 rounded-xl border bg-card p-5 shadow-sm"
          >
            <div className="flex items-start justify-between gap-2">
              <button
                type="button"
                className="min-w-0 text-left text-base font-semibold hover:text-primary"
                onClick={() => onOpen(task.id)}
              >
                <span className="break-words">{task.name}</span>
              </button>
              <TaskActions task={task} onEdit={onEdit} readOnly={readOnly} />
            </div>
            <button
              type="button"
              onClick={() => onOpen(task.id)}
              className="mt-3 block w-full text-left"
            >
              <p className="line-clamp-3 break-words text-sm text-muted-foreground">
                {task.prompt}
              </p>
              <p className="mt-4 break-words text-xs text-muted-foreground">
                {project?.name ?? task.projectId}
                {child ? ` / ${child.worktreeName}` : ""} · {task.provider}
              </p>
              <p className="mt-3 flex items-start gap-2 text-xs">
                <CalendarClock className="h-4 w-4 shrink-0" />
                <span>{scheduleLabel(task.schedule)}</span>
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {task.enabled
                  ? `下次运行：${displayTime(task.nextRunAt, task.schedule.timezone)}`
                  : "已暂停后续安排"}
              </p>
            </button>
          </article>
        );
      })}
    </div>
  );
}
