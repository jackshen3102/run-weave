import type { ContextPackManifest, EvolutionArtifactOverview, EvolutionArtifactPage, EvolutionArtifactPageQuery } from "@runweave/shared/evolution";

export interface EvolutionContextPackStore {
  getArtifactOverview(runId: string): Promise<EvolutionArtifactOverview>;
  getArtifactPage(runId: string, query: EvolutionArtifactPageQuery): Promise<EvolutionArtifactPage>;
  putContextPack(manifest: ContextPackManifest): Promise<void>;
  getContextPack(contextPackId: string): Promise<ContextPackManifest | null>;
  getContextPackByRun(runId: string): Promise<ContextPackManifest | null>;
}
