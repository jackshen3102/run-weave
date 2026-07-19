import { InMemoryEvolutionActivationStore } from "../../backend/src/evolution/activation-store.ts";
import { createCandidateAssets } from "../../backend/src/evolution/knowledge/candidate-factory.ts";
import {
  authorizeMemoryCanary,
  defaultEvolutionScopePolicy,
  validateEvolutionScopePolicy,
} from "../../backend/src/evolution/knowledge/lifecycle.ts";

export const scope = "project-main";
export const now = "2026-07-19T02:00:00.000Z";

export function draft(type, index = 0, overrides = {}) {
  return {
    type,
    learningScopeId: scope,
    insightRevisionId: `insight-rev-${type}-${index}`,
    statement: `statement ${type} ${index}`,
    guidance: `Read the evolution protocol before changing agent team code ${index}.`,
    rationale: "Corroborated by review and behavior evidence.",
    evidenceRefs: [`evidence-${type}-${index}`],
    counterEvidenceRefs: [`counter-${type}-${index}`],
    applicability: {
      workerRoles: ["code"],
      taskTerms: ["agent team"],
      pathPrefixes: ["backend/src/agent-team"],
    },
    exclusions: {},
    dependencies: { protocolRevision: "v1" },
    risk: "low",
    validFrom: now,
    ...overrides,
  };
}

export function enabledPolicy(overrides = {}) {
  return validateEvolutionScopePolicy({
    ...defaultEvolutionScopePolicy(scope, now),
    revision: 1,
    memoryCanaryEnabled: true,
    canaryRate: 1,
    updatedBy: "verifier",
    ...overrides,
  });
}

export function query(overrides = {}) {
  return {
    learningScopeId: scope,
    runId: "atr_activation_verifier",
    dispatchId: "dispatch-verifier",
    workerRole: "code",
    task: "Implement agent team startup behavior",
    intent: "Change agent team prompt injection",
    paths: ["backend/src/agent-team/service-execution.ts"],
    commands: ["pnpm typecheck"],
    failureSignatures: [],
    dependencies: { protocolRevision: "v1" },
    ...overrides,
  };
}

function withLifecycle(candidate, lifecycle, suffix) {
  return {
    ...candidate,
    revisionId: `${candidate.revisionId}-${suffix}`,
    lifecycle,
  };
}

export async function prepareActivationFixture() {
  const store = new InMemoryEvolutionActivationStore();
  await store.putPolicy(enabledPolicy());
  const source = createCandidateAssets(
    Array.from({ length: 5 }, (_, index) => draft("memory", index)),
    now,
  );
  const canaries = source.map(
    (candidate, index) =>
      authorizeMemoryCanary(
        candidate,
        enabledPolicy(),
        new Date(Date.parse(now) + index + 1).toISOString(),
      ).candidate,
  );
  const otherScope = withLifecycle(
    createCandidateAssets(
      [draft("memory", 20, { learningScopeId: "other-project" })],
      now,
    )[0],
    "canary",
    "other-scope",
  );
  const wrongRole = withLifecycle(
    createCandidateAssets(
      [
        draft("memory", 21, {
          applicability: { workerRoles: ["code_review"] },
        }),
      ],
      now,
    )[0],
    "canary",
    "wrong-role",
  );
  const retired = withLifecycle(
    createCandidateAssets([draft("memory", 24)], now)[0],
    "retired",
    "retired",
  );
  const expired = withLifecycle(
    createCandidateAssets(
      [draft("memory", 22, { expiresAt: "2026-07-18T00:00:00.000Z" })],
      now,
    )[0],
    "canary",
    "expired",
  );
  const excluded = withLifecycle(
    createCandidateAssets(
      [draft("memory", 23, { exclusions: { taskTerms: ["startup"] } })],
      now,
    )[0],
    "canary",
    "excluded",
  );
  for (const candidate of [
    ...canaries,
    otherScope,
    wrongRole,
    retired,
    expired,
    excluded,
  ]) {
    await store.putCandidate(candidate);
  }
  return { store, canaries };
}
