import { useMemoizedFn } from "ahooks";
import { ChevronRight, Eye, TriangleAlert } from "lucide-react";
import { useTaskSupervisionQuery } from "../../../features/terminal/queries/task-supervision";
import { useTerminalPreviewStore } from "../../../features/terminal/preview/store";
import { taskSupervisionNeedsAttention, taskSupervisionStatus } from "./status";

export function TerminalTaskSupervisionStatusStrip({ sessionId }: { sessionId: string | null }) {
  // This mounted terminal owns polling; the detail panel observes the same cache.
  const query = useTaskSupervisionQuery(sessionId, true);
  const open = useMemoizedFn(() => {
    useTerminalPreviewStore.getState().openTaskSupervision();
  });
  const watch = query.data?.watch;
  if (!watch?.enabled) return null;
  const attention = taskSupervisionNeedsAttention(watch) || query.isError;
  const label = taskSupervisionStatus(watch);
  const threadTitle = query.data?.threadTitle;
  const description = [threadTitle, label].filter(Boolean).join(" · ");
  const Icon = attention ? TriangleAlert : Eye;
  return (
    <button
      type="button"
      data-testid="terminal-task-supervision-status-strip"
      aria-label={`查看长任务监控：${description}`}
      title={query.isError ? `${description} · 状态暂时无法更新，显示上次结果` : description}
      onClick={open}
      className={`flex min-h-10 w-full shrink-0 items-center gap-2 border-b border-slate-800 px-3 py-2 text-left text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400 ${attention ? "bg-amber-950/20 text-amber-300 hover:bg-amber-950/30" : "bg-emerald-950/20 text-emerald-300 hover:bg-emerald-950/30"}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {threadTitle ? <span className="min-w-0 flex-1 truncate">{threadTitle}</span> : null}
      <span className={threadTitle ? "shrink-0" : "min-w-0 flex-1 truncate"}>{query.isError ? "上次状态 · " : ""}{label}</span>
      <span className="shrink-0 text-[11px] opacity-80">{watch.continuationCount}/{watch.continuationLimit} 次续接</span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    </button>
  );
}
