import { existsSync, statSync } from "node:fs";
import { ScheduledTaskError } from "./errors";
import type {
  CreateScheduledTaskRequest,
  ScheduledTask,
  ScheduledTaskValidation,
} from "@runweave/shared/scheduled-tasks";
import { nextOccurrences } from "./schedule";

export function validationResult(
  input: CreateScheduledTaskRequest | ScheduledTask,
  project: { id: string; name: string; path: string | null },
  nextRunAt: string | null,
  now: Date,
  currentRevision: number | null,
): ScheduledTaskValidation {
  return {
    config: { ...normalizeConfig(input), enabled: input.enabled },
    project: { id: project.id, name: project.name, path: project.path! },
    provider: input.provider,
    enabled: input.enabled,
    nextRunAt,
    occurrences: nextOccurrences(input.schedule, now, 3),
    currentRevision,
  };
}

export function normalizeConfig(
  input: CreateScheduledTaskRequest | ScheduledTask,
) {
  return {
    name: input.name.trim(),
    projectId: input.projectId,
    provider: input.provider,
    prompt: input.prompt.trim(),
    ...(input.continuationPolicy
      ? { continuationPolicy: input.continuationPolicy }
      : {}),
    ...(input.executionPolicy
      ? { executionPolicy: input.executionPolicy }
      : {}),
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    ...(input.effort?.trim() ? { effort: input.effort.trim() } : {}),
    schedule: input.schedule,
    misfirePolicy: input.misfirePolicy,
  };
}

export function isDirectory(value: string): boolean {
  try {
    return existsSync(value) && statSync(value).isDirectory();
  } catch {
    return false;
  }
}
export function scheduleError(error: unknown): ScheduledTaskError {
  return new ScheduledTaskError(
    "invalid_schedule",
    400,
    error instanceof Error ? error.message : "Invalid schedule",
  );
}
