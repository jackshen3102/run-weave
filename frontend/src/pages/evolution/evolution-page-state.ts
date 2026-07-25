import type {
  CandidateAsset,
  EvolutionRun,
  EvolutionSchedule,
  Insight,
  RuntimeTraceSummary,
} from "@runweave/shared/evolution";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
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
export const EMPTY_PROJECTS: TerminalProjectListItem[] = [];

export function buildEvolutionScopeOptions(
  projects: TerminalProjectListItem[],
): EvolutionScopeOption[] {
  return [
    {
      id: "global:runweave",
      kind: "global",
      label: "全部工作区",
      description: "复盘 Runweave 中所有工作区的完整流程",
    },
    ...projects.map((project) => ({
      id: project.projectId,
      kind: "project" as const,
      label: project.name,
      description: project.path ?? "包含该项目的主工作区与全部 Git worktree",
    })),
  ];
}

export function evolutionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Evolution 请求失败";
}
