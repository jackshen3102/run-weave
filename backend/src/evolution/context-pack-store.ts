import type { ContextPackManifest } from "@runweave/shared/evolution";

export interface EvolutionContextPackStore {
  putContextPack(manifest: ContextPackManifest): Promise<void>;
  getContextPack(contextPackId: string): Promise<ContextPackManifest | null>;
  getContextPackByRun(runId: string): Promise<ContextPackManifest | null>;
}
