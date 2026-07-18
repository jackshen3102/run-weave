import {
  applyAgentTeamFixtureBackendIsolation,
  resolveDevSessionBackendSharing,
} from "../dev-session/services.mjs";

export function verifyDevSessionBackendIsolation(check) {
  const fixtureScope = {
    ownerRunId: "atr_fixture_owner",
    ownerDispatchId: "dispatch-atfr-020",
  };
  const automaticSharedPlan = {
    services: {
      backend: {
        ownership: "shared-declared",
        selectedBy: "impact-closure",
      },
    },
  };
  const isolatedPlan = applyAgentTeamFixtureBackendIsolation(
    automaticSharedPlan,
    fixtureScope,
  );
  check(
    "ATFR-020-fixture-dev-session-upgrades-shared-backend",
    resolveDevSessionBackendSharing(automaticSharedPlan, fixtureScope) ===
      false &&
      isolatedPlan.services.backend.ownership === "dedicated" &&
      isolatedPlan.services.backend.selectedBy === "agent-team-fixture-scope",
    { automaticSharedPlan, isolatedPlan },
  );
  const explicitSharedPlan = {
    services: {
      backend: {
        ownership: "shared-declared",
        selectedBy: "explicit-service",
      },
    },
  };
  let explicitError = null;
  try {
    resolveDevSessionBackendSharing(explicitSharedPlan, fixtureScope);
  } catch (error) {
    explicitError = error;
  }
  check(
    "ATFR-020-fixture-dev-session-rejects-explicit-shared-backend",
    explicitError?.exitCode === 4 &&
      explicitError.message.includes("explicitly shared Backend"),
    explicitError,
  );
}
