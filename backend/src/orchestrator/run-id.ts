export const ORCHESTRATOR_RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isSafeOrchestratorRunId(runId: string): boolean {
  return ORCHESTRATOR_RUN_ID_PATTERN.test(runId);
}

export function assertSafeOrchestratorRunId(runId: string): void {
  if (!isSafeOrchestratorRunId(runId)) {
    throw new Error("Invalid orchestrator run id");
  }
}
