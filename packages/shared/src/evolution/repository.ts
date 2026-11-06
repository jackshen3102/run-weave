export interface EvolutionRepository {
  repositoryId: string;
  commonDirectory: string;
  paths: string[];
  projectIds: string[];
  name: string;
  available?: boolean;
  /** Hash of the persisted registration; required when removing it. */
  registrationVersion?: string;
  registrationHistory?: Array<{
    action: "removed";
    at: string;
    reason: string;
  }>;
}

export interface RemoveEvolutionRepositoryRequest {
  expectedRegistrationVersion: string;
  reason: string;
}

export interface EvolutionRepositoryContext {
  repositoryId: string;
  cwd: string;
  requestedProjectId?: string;
}

export interface EvolutionRepositoryAttribution {
  repositoryIds: string[];
  resolution: "resolved" | "mixed" | "unresolved";
  legacyLearningScopeId: string;
  reason?: string;
}

export interface EvolutionReflectionBatch {
  batchId: string;
  idempotencyKey: string;
  createdAt: string;
  snapshotBoundary: number;
  runIds: string[];
  repositoryIds: string[];
  maxWallTimeMs: number;
}

export function isEvolutionRepositoryId(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}
