import type { AgentTeamRunLineage } from "@runweave/shared/agent-team";

export interface AgentTeamEnvironmentFixtureScope {
  ownerRunId: string;
  ownerDispatchId: string;
  ownerCaseIds: string[];
  ownerDevSessionId: string | null;
  fixtureNamespace: string;
  ownsTerminalSession: boolean;
}

export function resolveAgentTeamEnvironmentFixtureScope(
  env: NodeJS.ProcessEnv,
): AgentTeamEnvironmentFixtureScope | null {
  const ownerRunId = env.RUNWEAVE_AGENT_TEAM_OWNER_RUN_ID?.trim() || null;
  const ownerDispatchId =
    env.RUNWEAVE_AGENT_TEAM_OWNER_DISPATCH_ID?.trim() || null;
  const rawCaseIds = env.RUNWEAVE_AGENT_TEAM_OWNER_CASE_IDS?.trim() || null;
  const fixtureNamespace =
    env.RUNWEAVE_AGENT_TEAM_FIXTURE_NAMESPACE?.trim() || null;
  const values = [ownerRunId, ownerDispatchId, rawCaseIds, fixtureNamespace];
  if (values.every((value) => value === null)) {
    return null;
  }
  if (values.some((value) => value === null)) {
    throw new Error(
      "Agent Team fixture scope environment is incomplete; refusing partial ownership",
    );
  }
  let ownerCaseIds: unknown;
  try {
    ownerCaseIds = JSON.parse(rawCaseIds!);
  } catch {
    throw new Error("RUNWEAVE_AGENT_TEAM_OWNER_CASE_IDS must be JSON");
  }
  if (
    !Array.isArray(ownerCaseIds) ||
    ownerCaseIds.length === 0 ||
    ownerCaseIds.some(
      (caseId) => typeof caseId !== "string" || caseId.trim().length === 0,
    )
  ) {
    throw new Error(
      "RUNWEAVE_AGENT_TEAM_OWNER_CASE_IDS must contain at least one case id",
    );
  }
  return {
    ownerRunId: ownerRunId!,
    ownerDispatchId: ownerDispatchId!,
    ownerCaseIds: Array.from(
      new Set(ownerCaseIds.map((caseId) => caseId.trim())),
    ),
    ownerDevSessionId:
      env.RUNWEAVE_AGENT_TEAM_OWNER_DEV_SESSION_ID?.trim() || null,
    fixtureNamespace: fixtureNamespace!,
    ownsTerminalSession:
      env.RUNWEAVE_AGENT_TEAM_FIXTURE_OWNS_TERMINAL_SESSION === "true",
  };
}

export function lineageFromEnvironmentFixtureScope(
  scope: AgentTeamEnvironmentFixtureScope,
): AgentTeamRunLineage {
  return {
    ownerRunId: scope.ownerRunId,
    ownerDispatchId: scope.ownerDispatchId,
    ownerCaseIds: scope.ownerCaseIds,
    ownerDevSessionId: scope.ownerDevSessionId,
    fixtureNamespace: scope.fixtureNamespace,
    ownsTerminalSession: scope.ownsTerminalSession,
    cleanupPolicy: "on_owner_dispatch_complete",
  };
}

export function fixtureLineageMismatch(
  expected: AgentTeamRunLineage,
  actual: AgentTeamRunLineage,
): string | null {
  if (actual.ownerRunId !== expected.ownerRunId) return "ownerRunId";
  if (actual.ownerDispatchId !== expected.ownerDispatchId) {
    return "ownerDispatchId";
  }
  if (actual.fixtureNamespace !== expected.fixtureNamespace) {
    return "fixtureNamespace";
  }
  if (actual.ownerDevSessionId !== expected.ownerDevSessionId) {
    return "ownerDevSessionId";
  }
  const allowedCases = new Set(expected.ownerCaseIds);
  if (
    actual.ownerCaseIds.length === 0 ||
    actual.ownerCaseIds.some((caseId) => !allowedCases.has(caseId))
  ) {
    return "ownerCaseIds";
  }
  if (actual.ownsTerminalSession !== expected.ownsTerminalSession) {
    return "ownsTerminalSession";
  }
  if (actual.cleanupPolicy !== expected.cleanupPolicy) {
    return "cleanupPolicy";
  }
  return null;
}
