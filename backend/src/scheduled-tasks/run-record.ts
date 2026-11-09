import { initialContinuation } from "./continuation";
import { randomUUID } from "node:crypto";
import type {
  ScheduledRun,
  ScheduledTask,
  ScheduledExecutionContext,
} from "@runweave/shared/scheduled-tasks";

export function createScheduledRunRecord(
  task: ScheduledTask,
  trigger: ScheduledRun["trigger"],
  scheduledFor: string,
  context: (runId: string) => ScheduledExecutionContext,
): ScheduledRun {
  const id = randomUUID();
  return {
    id,
    revision: 1,
    resultRevision: 0,
    activeAttemptId: null,
    ...(task.continuationPolicy?.mode === "bounded"
      ? { continuation: initialContinuation() }
      : {}),
    taskId: task.id,
    taskRevision: task.revision,
    snapshot: {
      name: task.name,
      provider: task.provider,
      prompt: task.prompt,
      executionPolicy: task.executionPolicy ?? "sandbox",
      ...(task.continuationPolicy
        ? { continuationPolicy: task.continuationPolicy }
        : {}),
      ...(task.model ? { model: task.model } : {}),
      ...(task.effort ? { effort: task.effort } : {}),
      schedule: task.schedule,
      misfirePolicy: task.misfirePolicy,
      ...(task.origin ? { origin: task.origin } : {}),
    },
    trigger,
    scheduledFor,
    dispatch: null,
    status: "queued",
    startedAt: null,
    finishedAt: null,
    summary: null,
    error: null,
    artifacts: [],
    outputCursor: "0",
    executionContext: context(id),
    threadRef: null,
    recoverable: false,
    terminalBinding: null,
  };
}
