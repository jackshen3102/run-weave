import type { ScheduledRun } from "@runweave/shared/scheduled-tasks";

/** Archive only finished quick-input runs; never reinterpret their execution result. */
export function archiveQuickInputRun(
  run: ScheduledRun,
  now: string,
  persist: (run: ScheduledRun) => ScheduledRun,
): ScheduledRun {
  if (run.snapshot.origin?.kind !== "quick-input")
    throw new Error("not_quick_input_run");
  if (!["completed", "failed", "cancelled", "skipped"].includes(run.status))
    throw new Error("run_not_finished");
  return run.archivedAt ? run : persist({ ...run, archivedAt: now });
}
