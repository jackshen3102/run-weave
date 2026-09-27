import { useQuery } from "@tanstack/react-query";
import type { EfficiencyFindingFilter } from "@runweave/shared/execution-efficiency";
import { executionEfficiencyApi } from "../../services/execution-efficiency";
import { useTerminalRuntime } from "../terminal/queries/provider";

export const efficiencyKeys = {
  all: (scope: string) => ["connection", scope, "execution-efficiency"] as const,
};

export function useEfficiencyApi() {
  const { apiBase, token, scope } = useTerminalRuntime();
  return { api: executionEfficiencyApi(apiBase, token), scope };
}

export function useEfficiencyStatus(projectId: string) {
  const { api, scope } = useEfficiencyApi();
  return useQuery({
    queryKey: [...efficiencyKeys.all(scope), "status", projectId],
    queryFn: ({ signal }) => api.status(projectId, signal),
    enabled: Boolean(projectId),
  });
}

export function useEfficiencyFindings(filter: EfficiencyFindingFilter) {
  const { api, scope } = useEfficiencyApi();
  return useQuery({
    queryKey: [...efficiencyKeys.all(scope), "findings", filter],
    queryFn: ({ signal }) => api.findings(filter, signal),
    enabled: Boolean(filter.projectId),
  });
}

export function useEfficiencyFinding(findingId: string | undefined) {
  const { api, scope } = useEfficiencyApi();
  return useQuery({
    queryKey: [...efficiencyKeys.all(scope), "finding", findingId],
    queryFn: ({ signal }) => api.finding(findingId!, signal),
    enabled: Boolean(findingId),
  });
}
