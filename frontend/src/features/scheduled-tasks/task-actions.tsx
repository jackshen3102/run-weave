import { useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ScheduledTask } from "@runweave/shared/scheduled-tasks";
import { MoreHorizontal } from "lucide-react";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { useScheduledApi, useRefreshTasks } from "./queries";
import { RequestError } from "./presentation";

export function TaskActions({
  task,
  onEdit,
  readOnly = false,
}: {
  task: ScheduledTask;
  readOnly?: boolean;
  onEdit: (task: ScheduledTask) => void;
}) {
  const { api } = useScheduledApi();
  const refresh = useRefreshTasks();
  const runKey = useRef<string | null>(null);
  const mutation = useMutation({
    mutationFn: async (action: "toggle" | "run" | "delete") => {
      if (action === "toggle")
        return api.update(task.id, {
          expectedRevision: task.revision,
          enabled: !task.enabled,
        });
      if (action === "delete") return api.remove(task.id, task.revision);
      runKey.current ??= crypto.randomUUID();
      const run = await api.start(task.id, runKey.current);
      runKey.current = null;
      return run;
    },
    onSettled: () => {
      void refresh();
    },
  });
  if (readOnly && !task.deletedAt)
    return (
      <span className="text-xs text-muted-foreground">调度已关闭 · 只读</span>
    );
  if (task.deletedAt)
    return <span className="text-xs text-muted-foreground">已删除 · 只读</span>;
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={task.enabled}
          aria-label={`${task.enabled ? "暂停" : "启用"} ${task.name}`}
          disabled={mutation.isPending}
          onClick={() => mutation.mutate("toggle")}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${task.enabled ? "bg-primary" : "bg-muted"}`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-background transition-transform ${task.enabled ? "left-0.5 translate-x-4" : "left-0.5"}`}
          />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label={`${task.name} 更多操作`}
              disabled={mutation.isPending}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => mutation.mutate("run")}>
              立即运行
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onEdit(task)}>
              编辑任务
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive"
              onSelect={() => {
                if (
                  window.confirm(
                    "删除任务并关闭后续安排？历史和已打开的终端将保留，正在执行的运行不会停止。",
                  )
                )
                  mutation.mutate("delete");
              }}
            >
              删除任务
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <RequestError error={mutation.error} />
    </div>
  );
}
