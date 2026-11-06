import type {
  EvolutionRepository,
  EvolutionRepositoryAttribution,
  EvolutionReflectionBatch,
  EvolutionRun,
} from "@runweave/shared/evolution";
import { createHash } from "node:crypto";

export type RepositoryCommand =
  | { op: "list" }
  | { op: "put"; repository: EvolutionRepository }
  | {
      op: "remove";
      repositoryId: string;
      expectedRegistrationVersion: string;
      reason: string;
    }
  | { op: "attribution"; kind: string; id: string }
  | { op: "batch-get"; key: string }
  | {
      op: "batch-create";
      batch: EvolutionReflectionBatch;
      runs: EvolutionRun[];
    };
export type RepositoryResult =
  | EvolutionRepository[]
  | EvolutionRepository
  | EvolutionRepositoryAttribution
  | EvolutionReflectionBatch
  | null
  | boolean;
export interface EvolutionRepositoryStore {
  repository(command: RepositoryCommand): Promise<RepositoryResult>;
}

export function repositoryRegistrationVersion(
  repository: EvolutionRepository,
): string {
  return createHash("sha256").update(JSON.stringify(repository)).digest("hex");
}

export function repositoryRegistrationRemoved(
  repository: EvolutionRepository,
): boolean {
  return repository.registrationHistory?.at(-1)?.action === "removed";
}
