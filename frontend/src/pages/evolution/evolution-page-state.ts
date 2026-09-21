import type {
  CandidateAsset,
  EvolutionRun,
  EvolutionSchedule,
  Insight,
  RuntimeTraceSummary,
} from "@runweave/shared/evolution";
import type { EvolutionRepository } from "@runweave/shared/evolution";
import type {
  EvolutionScopeOption,
  EvolutionView,
} from "./evolution-page-panels";

export const EVOLUTION_VIEWS = new Set<EvolutionView>([
  "overview",
  "runs",
  "insights",
  "candidates",
  "schedules",
]);

export const EMPTY_RUNS: EvolutionRun[] = [];
export const EMPTY_SCHEDULES: EvolutionSchedule[] = [];
export const EMPTY_CANDIDATES: CandidateAsset[] = [];
export const EMPTY_INSIGHTS: Insight[] = [];
export const EMPTY_TRACES: RuntimeTraceSummary[] = [];
export const EMPTY_PROJECTS: EvolutionRepository[] = [];

export function buildEvolutionScopeOptions(
  projects: EvolutionRepository[],
): EvolutionScopeOption[] {
  return [
    {
      id: "global:runweave",
      kind: "global",
      label: "全部仓库",
      description: `分别复盘 ${projects.filter((project) => project.available).length} 个可用仓库，最多 ${projects.filter((project) => project.available).length * 20} 分钟，顺序执行`,
    },
    ...projects.map((project) => ({
      id: project.repositoryId,
      kind: "repository" as const,
      cwd: project.paths[0],
      available: project.available,
      label: project.name,
      description: project.paths[0] ?? "仓库历史",
    })),
  ];
}

export function evolutionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Evolution 请求失败";
}

export function filterEvolutionScope<
  T extends {
    learningScopeId: string;
    attribution?: { repositoryIds: string[] };
  },
>(items: T[], scopeId: string): T[] {
  return scopeId === "global:runweave"
    ? items
    : items.filter(
        (item) =>
          item.learningScopeId === scopeId ||
          item.attribution?.repositoryIds.includes(scopeId),
      );
}
