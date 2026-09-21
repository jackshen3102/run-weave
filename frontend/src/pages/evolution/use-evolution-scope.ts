import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { EVOLUTION_GLOBAL_SCOPE_ID } from "@runweave/shared/evolution";
import {
  fetchEvolutionRepositories,
  resolveEvolutionScope,
} from "../../services/evolution";
import {
  buildEvolutionScopeOptions,
  EMPTY_PROJECTS,
} from "./evolution-page-state";
import type { EvolutionScopeOption } from "./evolution-page-panels";
export function useEvolutionScope(
  apiBase: string,
  token: string,
  requestedScope: string,
) {
  const projectsQuery = useQuery({
    queryKey: ["evolution", "project-metadata", apiBase],
    queryFn: () => fetchEvolutionRepositories(apiBase, token),
  });
  const projects = projectsQuery.data?.repositories ?? EMPTY_PROJECTS;
  const scopeOptions = useMemo<EvolutionScopeOption[]>(
    () => buildEvolutionScopeOptions(projects),
    [projects],
  );
  const requestedScopeId = requestedScope;
  const legacyScopeQuery = useQuery({
    queryKey: ["evolution", "legacy-scope", apiBase, requestedScopeId],
    queryFn: () => resolveEvolutionScope(apiBase, token, requestedScopeId),
    enabled:
      !!requestedScopeId &&
      requestedScopeId !== EVOLUTION_GLOBAL_SCOPE_ID &&
      !scopeOptions.some((scope) => scope.id === requestedScopeId) &&
      !projectsQuery.isLoading,
    retry: false,
  });
  const selectedScopeId =
    legacyScopeQuery.data?.repositoryId ??
    (requestedScopeId || EVOLUTION_GLOBAL_SCOPE_ID);
  const selectedScope = scopeOptions.find(
    (scope) => scope.id === selectedScopeId,
  ) ?? {
    id: selectedScopeId,
    kind: "legacy" as const,
    label: "历史范围",
    description: "历史归属未确认；可查看原始记录",
  };
  return {
    scopeOptions,
    selectedScopeId,
    selectedScope,
    scopeError:
      projectsQuery.error ??
      (legacyScopeQuery.error
        ? new Error(
            "旧范围无法唯一对应仓库：历史可能涉及多个仓库，或缺少可靠归属依据。原始记录仍可查看，请从左侧选择仓库。",
          )
        : null),
  };
}
