export const AGENT_TEAM_RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isSafeAgentTeamRunId(runId: string): boolean {
  return AGENT_TEAM_RUN_ID_PATTERN.test(runId);
}

export function assertSafeAgentTeamRunId(runId: string): void {
  if (!isSafeAgentTeamRunId(runId)) {
    throw new Error("Invalid agent-team run id");
  }
}

/** Create a filesystem-safe run id keyed off the terminal session. */
export function createAgentTeamRunId(seed: string): string {
  const suffix = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  const safeSeed = seed.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "run";
  return `atr_${safeSeed}_${suffix}`;
}
