import {
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
    guidance: `Read the evolution protocol before changing terminal code ${index}.`,
    rationale: "Corroborated by review and behavior evidence.",
    evidenceRefs: [`evidence-${type}-${index}`],
    counterEvidenceRefs: [`counter-${type}-${index}`],
    applicability: {
      workerRoles: ["code"],
      taskTerms: ["terminal"],
      pathPrefixes: ["backend/src/terminal"],
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
