import type {
  EvolutionRun,
  EvolutionRunStage,
  EvolutionSchedule,
} from "@runweave/shared/evolution";
import type { EvolutionDueScheduleMaterialization } from "../foundation-store";

export const EVOLUTION_ACTIVE_STAGES: EvolutionRunStage[] = [
  "snapshotting",
  "segmenting",
  "independent_analysis",
  "cross_questioning",
  "adjudicating",
  "novelty_check",
  "validating",
];

export const EVOLUTION_TERMINAL_STAGES: EvolutionRunStage[] = [
  "completed",
  "no_material_novelty",
  "partial",
  "failed",
  "cancelled",
  "blocked",
];

export function evolutionTriggerPriority(
  type: EvolutionRun["trigger"]["type"],
): number {
  if (type === "manual") return 0;
  if (type === "event") return 1;
  return 2;
}

export function parseEvolutionTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("evolution_invalid_timestamp");
  return parsed;
}

export function isAllowedEvolutionRunTransition(
  current: EvolutionRunStage,
  next: EvolutionRunStage,
): boolean {
  if (next === "partial" || next === "failed" || next === "blocked") {
    return EVOLUTION_ACTIVE_STAGES.includes(current);
  }
  if (current === "snapshotting") return next === "segmenting";
  if (current === "segmenting") return next === "independent_analysis";
  if (current === "independent_analysis") {
    return next === "cross_questioning";
  }
  if (current === "cross_questioning") {
    return next === "adjudicating" || next === "novelty_check";
  }
  if (current === "adjudicating") return next === "novelty_check";
  if (current === "novelty_check") return next === "validating";
  if (current === "validating") {
    return next === "completed" || next === "no_material_novelty";
  }
  return false;
}

export function assertScheduleMaterialization(
  current: EvolutionSchedule,
  params: EvolutionDueScheduleMaterialization,
): void {
  const trigger = params.run.trigger;
  if (
    trigger.type !== "schedule" ||
    trigger.scheduleId !== current.scheduleId ||
    parseEvolutionTimestamp(trigger.dueAt) <
      parseEvolutionTimestamp(params.expectedNextDueAt) ||
    parseEvolutionTimestamp(trigger.dueAt) >
      parseEvolutionTimestamp(params.now) ||
    params.run.learningScopeId !== current.learningScopeId ||
    params.nextSchedule.scheduleId !== current.scheduleId ||
    params.nextSchedule.learningScopeId !== current.learningScopeId ||
    params.nextSchedule.lastDueAt !== trigger.dueAt ||
    params.nextSchedule.lastRunId !== params.run.runId
  ) {
    throw new Error("evolution_schedule_materialization_invalid");
  }
}
