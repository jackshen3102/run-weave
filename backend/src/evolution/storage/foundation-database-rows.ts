import type {
  EvolutionRun,
  EvolutionRunOutcome,
  EvolutionRunStage,
} from "@runweave/shared/evolution";
import { parseEvolutionTimestamp } from "./foundation-rules";

export interface EvolutionRunRow {
  run_id: string;
  learning_scope_id: string;
  trigger_type: string;
  priority: number;
  trigger_json: string;
  profile: EvolutionRun["profile"];
  provider_policy: EvolutionRun["providerPolicy"];
  budget_json: string;
  data_range_json: string;
  stage: EvolutionRunStage;
  outcome: EvolutionRunOutcome | null;
  created_at_ms: number;
  updated_at_ms: number;
  started_at_ms: number | null;
  completed_at_ms: number | null;
  attempt: number;
  owner_id: string | null;
  fencing_token: number | null;
}

export interface EvolutionLeaseRow {
  owner_id: string;
  fencing_token: number;
  expires_at_ms: number;
}

export function toRun(row: EvolutionRunRow): EvolutionRun {
  return {
    runId: row.run_id,
    learningScopeId: row.learning_scope_id,
    trigger: JSON.parse(row.trigger_json) as EvolutionRun["trigger"],
    profile: row.profile,
    providerPolicy: row.provider_policy,
    budget: JSON.parse(row.budget_json) as EvolutionRun["budget"],
    dataRange: JSON.parse(row.data_range_json) as EvolutionRun["dataRange"],
    stage: row.stage,
    outcome: row.outcome,
    createdAt: toIso(row.created_at_ms),
    updatedAt: toIso(row.updated_at_ms),
    startedAt: row.started_at_ms === null ? null : toIso(row.started_at_ms),
    completedAt:
      row.completed_at_ms === null ? null : toIso(row.completed_at_ms),
    attempt: row.attempt,
  };
}

export function nullableTimestamp(value: string | null): number | null {
  return value === null ? null : parseEvolutionTimestamp(value);
}

export function toIso(value: number): string {
  return new Date(value).toISOString();
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
