import { useQuery } from "@tanstack/react-query";
import type {
  TerminalProjectContextBranchStatus,
  TerminalProjectContextListItem,
} from "@runweave/shared/terminal/project-context";
import { getTerminalProjectContextBranchStatuses } from "../../../services/terminal/projects";
import { terminalQueryKeys } from "./keys";
import { useTerminalRuntime } from "./provider";

const FRESHNESS_MS = 600_000;

export function isWorktreeBranchStatusStale(status: TerminalProjectContextBranchStatus): boolean {
  return status.state !== "ready" || !status.checkedAt
    || Date.now() - Date.parse(status.checkedAt) >= FRESHNESS_MS;
}

export function useTerminalProjectContextBranchStatuses(
  parentProjectId: string | null,
  contexts: TerminalProjectContextListItem[],
  enabled: boolean,
) {
  const { apiBase, scope, token } = useTerminalRuntime();
  const available = contexts.filter((context) => context.availability === "available" && context.path);
  return useQuery({
    queryKey: [
      ...terminalQueryKeys.projectContextBranchStatuses(scope, parentProjectId ?? ""),
      available.map(({ projectId, path, head }) => [projectId, path, head]),
    ],
    queryFn: async () => {
      const statuses: TerminalProjectContextBranchStatus[] = [];
      // Match mobile's bounded requests; a context needs no running terminal.
      for (let start = 0; start < available.length; start += 4) {
        const response = await getTerminalProjectContextBranchStatuses(apiBase, token,
          parentProjectId ?? "", { projectIds: available.slice(start, start + 4).map((context) => context.projectId) });
        statuses.push(...response.statuses);
      }
      return statuses;
    },
    enabled: enabled && Boolean(parentProjectId) && available.length > 0,
    staleTime: 30_000,
    refetchInterval: (query) => query.state.error || !query.state.data
      || query.state.data.some((status) => status.state !== "not-repository"
        && isWorktreeBranchStatusStale(status)) ? 30_000 : FRESHNESS_MS,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
