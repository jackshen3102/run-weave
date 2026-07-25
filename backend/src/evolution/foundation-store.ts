import type {
  EvolutionRun,
  EvolutionRunOutcome,
  EvolutionRunStage,
  EvolutionSchedule,
  EvolutionWatermark,
} from "@runweave/shared/evolution";

export interface EvolutionRunListQuery {
  learningScopeId?: string;
  stage?: EvolutionRunStage;
  limit?: number;
}

export interface EvolutionRunClaim {
  run: EvolutionRun;
  ownerId: string;
  fencingToken: number;
  leaseExpiresAt: string;
}

export interface EvolutionRunTransition {
  runId: string;
  ownerId: string;
  fencingToken: number;
  expectedStage: EvolutionRunStage;
  nextStage: EvolutionRunStage;
  outcome?: EvolutionRunOutcome | null;
  now: string;
}

export interface EvolutionDueScheduleMaterialization {
  scheduleId: string;
  expectedNextDueAt: string;
  now: string;
  run: EvolutionRun;
  nextSchedule: EvolutionSchedule;
}

export interface EvolutionFoundationStore {
  createRun(run: EvolutionRun): Promise<void>;
  getRun(runId: string): Promise<EvolutionRun | null>;
  listRuns(query?: EvolutionRunListQuery): Promise<EvolutionRun[]>;
  claimNextRun(params: {
    ownerId: string;
    now: string;
    leaseTtlMs: number;
  }): Promise<EvolutionRunClaim | null>;
  heartbeatRunClaim(params: {
    ownerId: string;
    fencingToken: number;
    now: string;
    leaseTtlMs: number;
  }): Promise<string>;
  transitionRun(transition: EvolutionRunTransition): Promise<EvolutionRun>;
  cancelRun(runId: string, now: string): Promise<EvolutionRun>;
  recoverExpiredRuns(now: string): Promise<number>;
  putSchedule(schedule: EvolutionSchedule): Promise<void>;
  getSchedule(scheduleId: string): Promise<EvolutionSchedule | null>;
  listSchedules(learningScopeId?: string): Promise<EvolutionSchedule[]>;
  materializeDueSchedule(
    params: EvolutionDueScheduleMaterialization,
  ): Promise<boolean>;
  deleteSchedule(scheduleId: string): Promise<boolean>;
  getWatermark(
    learningScopeId: string,
    source: string,
  ): Promise<EvolutionWatermark | null>;
  putWatermark(params: {
    watermark: EvolutionWatermark;
    ownerId: string;
    fencingToken: number;
    now: string;
  }): Promise<void>;
}
