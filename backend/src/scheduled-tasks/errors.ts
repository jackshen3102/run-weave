export class ScheduledTaskError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ScheduledTaskError";
  }
}

export function scheduledTaskErrorFromStorage(
  error: unknown,
): ScheduledTaskError {
  const message = error instanceof Error ? error.message : String(error);
  const [code, detail] = message.split(":", 2);
  switch (code) {
    case "scheduled_record_invalid": {
      const [, recordKind, recordId, field] = message.split(":");
      return new ScheduledTaskError(
        code,
        503,
        "Persisted scheduled task record is invalid",
        { recordKind, recordId, field },
      );
    }
    case "scheduled_task_not_found":
    case "scheduled_run_not_found":
      return new ScheduledTaskError(
        code,
        404,
        "Scheduled task resource not found",
      );
    case "revision_conflict":
      return new ScheduledTaskError(
        code,
        409,
        "The task changed; refresh before saving",
      );
    case "idempotency_conflict":
      return new ScheduledTaskError(
        code,
        409,
        "Idempotency key was reused with different input",
      );
    case "run_busy":
      return new ScheduledTaskError(
        code,
        409,
        "This task already has an unfinished run",
        detail ? { runId: detail } : undefined,
      );
    default:
      return new ScheduledTaskError(
        "scheduler_unavailable",
        503,
        "Scheduled task storage is unavailable",
      );
  }
}
