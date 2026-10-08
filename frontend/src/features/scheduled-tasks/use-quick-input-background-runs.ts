import { useMemoizedFn } from "ahooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ScheduledRun } from "@runweave/shared/scheduled-tasks";
import { HttpError } from "../../services/http";
import { scheduledTasksApi } from "../../services/scheduled-tasks";
import { useTerminalRuntime } from "../terminal/queries/provider";
import { scheduledKeys } from "./queries";

export function isQuickInputRunActive(run: ScheduledRun) {
  return (
    ["queued", "running", "stopping"].includes(run.status) ||
    (run.status === "waiting" && Boolean(run.continuation?.nextAt))
  );
}
export function quickInputRunNeedsAttention(run: ScheduledRun) {
  if (isQuickInputRunActive(run)) return false;
  return (
    run.outcome === "blocked" ||
    run.outcome === "failed" ||
    run.status === "failed" ||
    run.status === "waiting"
  );
}
export function canArchiveQuickInputRun(run: ScheduledRun) {
  return (
    run.snapshot.origin?.kind === "quick-input" &&
    !run.archivedAt &&
    ["completed", "failed", "cancelled", "skipped"].includes(run.status)
  );
}
export function quickInputRunLabel(run: ScheduledRun) {
  if (run.status === "waiting" && run.continuation?.nextAt)
    return "等待自动继续";
  if (run.status === "running" && run.continuation?.count) return "继续处理中";
  if (run.outcome === "blocked") return "执行受阻";
  if (run.outcome === "failed") return "执行失败";
  if (run.status === "completed")
    return run.outcome === "succeeded" ? "已完成" : "运行已结束";
  return {
    queued: "排队中",
    running: "运行中",
    stopping: "停止中",
    waiting: "等待处理",
    failed: "失败",
    cancelled: "已停止",
    skipped: "已跳过",
  }[run.status];
}
export function quickInputRunProjectLabel(run: ScheduledRun) {
  const origin = run.snapshot.origin;
  return origin?.kind === "quick-input"
    ? `${origin.projectName} / ${origin.worktreeName ?? "主项目"}`
    : run.cwd;
}

export function useQuickInputBackgroundRuns(enabled: boolean) {
  const { apiBase, token, scope } = useTerminalRuntime();
  const client = useQueryClient();
  const queryKey = [...scheduledKeys.all(scope), "quick-input-runs"];
  const query = useQuery({
    queryKey,
    enabled,
    queryFn: async ({ signal }) => {
      const records: ScheduledRun[] = [];
      let cursor: string | undefined;
      do {
        const page = await scheduledTasksApi(apiBase, token).quickInputRuns(
          {
            source: "quick-input",
            limit: 100,
            cursor,
          },
          signal,
        );
        records.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return [...new Map(records.map((run) => [run.id, run])).values()];
    },
    refetchInterval: 5_000,
  });
  const upsertBackgroundRun = useMemoizedFn((run: ScheduledRun) => {
    // Cancel an older list read so it cannot overwrite a just-created/archived run.
    void client.cancelQueries({ queryKey });
    client.setQueryData<ScheduledRun[]>(queryKey, (current = []) =>
      [run, ...current.filter((item) => item.id !== run.id)].sort((a, b) =>
        b.scheduledFor.localeCompare(a.scheduledFor),
      ),
    );
    void client.invalidateQueries({ queryKey });
  });
  const backgroundRuns = query.data ?? [];
  const ranks: Record<string, number> = { running: 1, stopping: 2, queued: 3 };
  const dashboardRuns = backgroundRuns
    .filter(
      (run) =>
        !run.archivedAt &&
        (isQuickInputRunActive(run) || quickInputRunNeedsAttention(run)),
    )
    .sort((a, b) => {
      const rank = (run: ScheduledRun) =>
        quickInputRunNeedsAttention(run) ? 0 : (ranks[run.status] ?? 4);
      return (
        rank(a) - rank(b) ||
        b.scheduledFor.localeCompare(a.scheduledFor) ||
        a.id.localeCompare(b.id)
      );
    });
  const historyRuns = backgroundRuns.filter(
    (run) =>
      run.archivedAt ||
      (!isQuickInputRunActive(run) && !quickInputRunNeedsAttention(run)),
  );
  return {
    backgroundRuns,
    dashboardRuns,
    historyRuns,
    upsertBackgroundRun,
    loading: query.isPending,
    error: query.error,
    refresh: query.refetch,
    backgroundAvailable: !(
      query.error instanceof HttpError && query.error.status === 404
    ),
  };
}
