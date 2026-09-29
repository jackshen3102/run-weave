import type { ScheduledRun } from "@runweave/shared/scheduled-tasks";

export function backgroundRunPath(runId: string): string {
  return `/background-runs/${encodeURIComponent(runId)}`;
}

export function runDetailsPath(
  run: Pick<ScheduledRun, "id" | "taskId" | "snapshot">,
): string {
  return run.snapshot.origin?.kind === "quick-input"
    ? backgroundRunPath(run.id)
    : `/scheduled-tasks/${encodeURIComponent(run.taskId)}?run=${encodeURIComponent(run.id)}`;
}
