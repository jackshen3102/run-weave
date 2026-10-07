import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTerminalRuntime } from "./provider";
import { fetchTaskSupervision } from "../../../services/task-supervision";
import { HttpError } from "../../../services/http";

export function useTaskSupervisionQuery(sessionId: string | null, poll = false) {
  const { apiBase, token, scope, onAuthExpired } = useTerminalRuntime();
  const query = useQuery({
    queryKey: ["task-supervision", scope, sessionId],
    queryFn: ({ signal }) =>
      fetchTaskSupervision(apiBase, token, sessionId!, null, signal),
    enabled: sessionId !== null,
    staleTime: 4_000,
    refetchInterval: poll ? 5_000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  useEffect(() => {
    if (query.error instanceof HttpError && query.error.status === 401)
      onAuthExpired?.();
  }, [query.error, onAuthExpired]);
  return query;
}
