import type {
  EvolutionRepository,
  EvolutionRepositoryAttribution,
  EvolutionReflectionBatch,
  EvolutionRun,
} from "@runweave/shared/evolution";

export type RepositoryCommand =
  | { op: "list" }
  | { op: "put"; repository: EvolutionRepository }
  | { op: "attribution"; kind: string; id: string }
  | { op: "batch-get"; key: string }
  | {
      op: "batch-create";
      batch: EvolutionReflectionBatch;
      runs: EvolutionRun[];
    };
export type RepositoryResult =
  | EvolutionRepository[]
  | EvolutionRepositoryAttribution
  | EvolutionReflectionBatch
  | null
  | boolean;
export interface EvolutionRepositoryStore {
  repository(command: RepositoryCommand): Promise<RepositoryResult>;
}
