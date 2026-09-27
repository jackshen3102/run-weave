export class ExecutionEfficiencyError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ExecutionEfficiencyError";
  }
}

export function efficiencyStorageError(error: unknown): ExecutionEfficiencyError {
  if (error instanceof ExecutionEfficiencyError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("efficiency_schema_too_new")) {
    return new ExecutionEfficiencyError(
      "storage_unavailable",
      503,
      "Execution efficiency storage uses a newer schema",
    );
  }
  return new ExecutionEfficiencyError(
    "storage_unavailable",
    503,
    "Execution efficiency storage is unavailable",
  );
}
