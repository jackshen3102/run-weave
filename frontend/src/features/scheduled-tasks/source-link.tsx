import type { ScheduledTaskSource } from "@runweave/shared/scheduled-tasks";
import { useRun } from "./queries";
import { useEnterScheduledTasks } from "./navigation";

export function ScheduledTaskSourceLink({
  source,
}: {
  source: ScheduledTaskSource;
}) {
  const run = useRun(source.runId, false);
  const enter = useEnterScheduledTasks();
  return (
    <button
      type="button"
      className="max-w-44 truncate rounded px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
      title={
        run.error ? "无法读取来源名称，点击查看来源" : run.data?.snapshot.name
      }
      onClick={() =>
        enter(
          `/scheduled-tasks/${encodeURIComponent(source.taskId)}?run=${encodeURIComponent(source.runId)}`,
        )
      }
    >
      来源：
      {run.data?.taskId === source.taskId ? run.data.snapshot.name : "定时任务"}
    </button>
  );
}
