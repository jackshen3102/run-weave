import type { EvolutionRun } from "@runweave/shared/evolution";
export function evolutionRunLabel(run: EvolutionRun): string {
  if (run.repository)
    return (
      run.repository.cwd.split("/").filter(Boolean).at(-1) ??
      run.learningScopeId
    );
  if (run.learningScopeId === "global:runweave") return "历史全局复盘";
  if (run.attribution?.resolution === "mixed") return "历史混合仓库复盘";
  return `历史复盘 · ${run.learningScopeId.slice(0, 8)}`;
}
