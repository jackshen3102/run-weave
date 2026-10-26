import { useEffect, useRef } from "react";
import { useMemoizedFn } from "ahooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getProjectBranchUpdates } from "../../../services/terminal/branch-updates";
import { HttpError } from "../../../services/http";
import { terminalQueryKeys } from "./keys";
import { useTerminalRuntime } from "./provider";

export function useBranchUpdates(projectId: string | null, path: string | null, enabled: boolean) {
  const { apiBase, token, scope, onAuthExpired } = useTerminalRuntime();
  const queryClient = useQueryClient();
  const force = useRef(false);
  const query = useQuery({
    queryKey: ["branch-updates", scope, projectId, path],
    queryFn: ({ signal }) => {
      const refresh = force.current;
      force.current = false;
      return getProjectBranchUpdates(apiBase, token, projectId!, refresh, signal);
    },
    enabled: enabled && Boolean(projectId && path),
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    staleTime: 0,
  });
  useEffect(() => {
    if (query.error instanceof HttpError && query.error.status === 401) onAuthExpired?.();
  }, [query.error, onAuthExpired]);
  useEffect(() => {
    if (query.data?.state === "ready") void queryClient.invalidateQueries({
      queryKey: [...terminalQueryKeys.all(scope), "project-context-branch-statuses"],
    });
  }, [query.dataUpdatedAt, query.data?.state, queryClient, scope]);
  const refresh = useMemoizedFn(() => {
    if (!enabled || query.isFetching) return;
    force.current = true;
    void query.refetch();
  });
  // A changed/missing target cannot retain the previous target's cached content.
  const invalidTarget = query.error instanceof HttpError && [404, 409].includes(query.error.status);
  return { ...query, data: invalidTarget ? undefined : query.data, refresh };
}
