import { randomUUID } from "node:crypto";
import type {
  ScheduledRun,
  ScheduledTask,
} from "@runweave/shared/scheduled-tasks";

export function createScheduledRunRecord(
  task: ScheduledTask,
  trigger: ScheduledRun["trigger"],
  scheduledFor: string,
  cwd: string,
): ScheduledRun {
  return {
    id: randomUUID(),
    taskId: task.id,
    taskRevision: task.revision,
    snapshot: {
      name: task.name,
      projectId: task.projectId,
      provider: task.provider,
      prompt: task.prompt,
      executionPolicy: task.executionPolicy ?? "sandbox",
      ...(task.model ? { model: task.model } : {}),
      ...(task.effort ? { effort: task.effort } : {}),
      schedule: task.schedule,
      misfirePolicy: task.misfirePolicy,
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
    executionProjectId: task.projectId,
    cwd,
    threadRef: null,
    recoverable: false,
    terminalBinding: null,
  };
}
