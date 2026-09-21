import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  focusManager,
  onlineManager,
} from "@tanstack/react-query";
import type { ScheduledTaskFilter } from "@runweave/shared/scheduled-tasks";
import { useTerminalRuntime } from "../terminal/queries/provider";
import { scheduledTasksApi } from "../../services/scheduled-tasks";

export const scheduledKeys = {
  all: (scope: string) => ["connection", scope, "scheduled-tasks"] as const,
};
export const pollInterval = () =>
  focusManager.isFocused() && onlineManager.isOnline() ? 3_000 : false;

export function useScheduledApi() {
  const { apiBase, token, scope } = useTerminalRuntime();
  return { api: scheduledTasksApi(apiBase, token), scope };
}
export function useCapabilities() {
  const { api, scope } = useScheduledApi();
  return useQuery({
    queryKey: [...scheduledKeys.all(scope), "capabilities"],
    queryFn: ({ signal }) => api.capabilities(signal),
  });
}
export function useTasks(filter: ScheduledTaskFilter, enabled: boolean) {
  const { api, scope } = useScheduledApi();
  return useInfiniteQuery({
    queryKey: [...scheduledKeys.all(scope), "list", filter],
    queryFn: ({ signal, pageParam }) =>
      api.list({ ...filter, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: pollInterval,
    enabled,
  });
}
export function useTask(taskId: string, enabled = true) {
  const { api, scope } = useScheduledApi();
  return useQuery({
    queryKey: [...scheduledKeys.all(scope), "task", taskId],
    queryFn: ({ signal }) => api.task(taskId, signal),
    enabled: enabled && Boolean(taskId),
    refetchInterval: pollInterval,
  });
}
export function useRuns(taskId: string) {
  const { api, scope } = useScheduledApi();
  return useInfiniteQuery({
    queryKey: [...scheduledKeys.all(scope), "runs", taskId],
    queryFn: ({ signal, pageParam }) => api.runs(taskId, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: pollInterval,
  });
}
export function useRun(runId: string | null, poll = true) {
  const { api, scope } = useScheduledApi();
  return useQuery({
    queryKey: [...scheduledKeys.all(scope), "run", runId],
    queryFn: ({ signal }) => api.run(runId!, signal),
    enabled: Boolean(runId),
    refetchInterval: poll ? pollInterval : false,
  });
}
export function useRefreshTasks() {
  const { scope } = useScheduledApi();
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: scheduledKeys.all(scope) });
}
