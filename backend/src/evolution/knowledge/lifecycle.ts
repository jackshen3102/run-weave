import { createHash } from "node:crypto";
import type {
  CandidateAsset,
  CandidateLifecycleDecision,
  CandidatePromotionEvidence,
  EvidenceGrade,
  EvolutionDependencyFingerprint,
  EvolutionScopePolicy,
} from "@runweave/shared/evolution";

const EVIDENCE_RANK: Record<EvidenceGrade, number> = {
  E1: 1,
  E2: 2,
  E3: 3,
  E4: 4,
};

const DEPENDENCY_KEYS = [
  "sourceRevision",
  "protocolRevision",
  "provider",
  "model",
  "toolRevision",
  "systemPromptRevision",
  "evidenceRevision",
] as const satisfies ReadonlyArray<keyof EvolutionDependencyFingerprint>;

export function defaultEvolutionScopePolicy(
  learningScopeId: string,
  now: string = new Date().toISOString(),
): EvolutionScopePolicy {
  return {
    learningScopeId,
    revision: 0,
    memoryCanaryEnabled: false,
    canaryRate: 0,
    maxInjectedAssets: 3,
    maxInjectionBytes: 6_000,
    autoPromotion: false,
    minimumPromotionGrade: "E4",
    minimumPromotionSamples: 10,
    updatedAt: now,
    updatedBy: "system-default",
  };
}

export function validateEvolutionScopePolicy(
  policy: EvolutionScopePolicy,
): EvolutionScopePolicy {
  if (policy.canaryRate < 0 || policy.canaryRate > 1) {
    throw new Error("evolution_policy_canary_rate_out_of_range");
  }
  if (policy.maxInjectedAssets < 0 || policy.maxInjectedAssets > 3) {
    throw new Error("evolution_policy_asset_cap_out_of_range");
  }
  if (policy.maxInjectionBytes < 0 || policy.maxInjectionBytes > 6_000) {
    throw new Error("evolution_policy_byte_cap_out_of_range");
  }
  if (policy.minimumPromotionSamples < 1) {
    throw new Error("evolution_policy_sample_threshold_invalid");
  }
  if (!policy.memoryCanaryEnabled && policy.canaryRate !== 0) {
    throw new Error("evolution_policy_disabled_canary_must_be_zero");
  }
  if (!policy.memoryCanaryEnabled && policy.autoPromotion) {
    throw new Error("evolution_policy_disabled_promotion_forbidden");
  }
  return policy;
}

function nextRevision(
  candidate: CandidateAsset,
  lifecycle: CandidateAsset["lifecycle"],
  reason: string,
  now: string,
  audit: { actor: string; evidenceRefs?: string[] },
): CandidateAsset {
  const revisionId = `arev_${createHash("sha256")
    .update(`${candidate.revisionId}\n${lifecycle}\n${reason}\n${now}`)
    .digest("hex")
    .slice(0, 20)}`;
  return {
    ...candidate,
    revisionId,
    lifecycle,
    updatedAt: now,
    lifecycleHistory: [
      ...candidate.lifecycleHistory,
      {
        eventId: `ale_${createHash("sha256")
          .update(`${revisionId}\n${audit.actor}\n${reason}`)
          .digest("hex")
          .slice(0, 20)}`,
        from: candidate.lifecycle,
        to: lifecycle,
        actor: audit.actor,
        reason,
        evidenceRefs: [...(audit.evidenceRefs ?? [])],
        at: now,
      },
    ],
  };
}

export function authorizeMemoryCanary(
  candidate: CandidateAsset,
  policy: EvolutionScopePolicy,
  now: string = new Date().toISOString(),
): CandidateLifecycleDecision {
  validateEvolutionScopePolicy(policy);
  if (candidate.type !== "memory") {
    return {
      candidate,
      changed: false,
      reason: "non_memory_activation_forbidden",
    };
  }
  if (candidate.learningScopeId !== policy.learningScopeId) {
    return { candidate, changed: false, reason: "learning_scope_mismatch" };
  }
  if (!policy.memoryCanaryEnabled || policy.canaryRate <= 0) {
    return { candidate, changed: false, reason: "scope_policy_disabled" };
  }
  if (candidate.risk !== "low") {
    return {
      candidate,
      changed: false,
      reason: "only_low_risk_memory_allowed",
    };
  }
  if (candidate.lifecycle !== "shadow") {
    return { candidate, changed: false, reason: "memory_must_be_shadow" };
  }
  return {
    candidate: nextRevision(
      candidate,
      "canary",
      "scope_policy_authorized",
      now,
      { actor: policy.updatedBy },
    ),
    changed: true,
    reason: "scope_policy_authorized",
  };
}

export function evaluateAutomaticPromotion(
  candidate: CandidateAsset,
  policy: EvolutionScopePolicy,
  evidence: CandidatePromotionEvidence,
  now: string = new Date().toISOString(),
): CandidateLifecycleDecision {
  validateEvolutionScopePolicy(policy);
  if (candidate.type !== "memory") {
    return {
      candidate,
      changed: false,
      reason: "non_memory_activation_forbidden",
    };
  }
  if (evidence.criticalRegressionCount > 0) {
    return {
      candidate: nextRevision(
        candidate,
        "retired",
        "critical_regression",
        now,
        {
          actor: "automatic-promotion-gate",
          evidenceRefs: evidence.evidenceRefs,
        },
      ),
      changed: true,
      reason: "critical_regression",
    };
  }
  if (!policy.autoPromotion) {
    return {
      candidate,
      changed: false,
      reason: "automatic_promotion_disabled",
    };
  }
  if (
    EVIDENCE_RANK[evidence.grade] < EVIDENCE_RANK[policy.minimumPromotionGrade]
  ) {
    return { candidate, changed: false, reason: "objective_evidence_required" };
  }
  if (evidence.sampleCount < policy.minimumPromotionSamples) {
    return { candidate, changed: false, reason: "sample_threshold_not_met" };
  }
  if (!evidence.objectiveImprovement) {
    return {
      candidate,
      changed: false,
      reason: "objective_improvement_absent",
    };
  }
  if (candidate.lifecycle !== "canary") {
    return { candidate, changed: false, reason: "candidate_not_in_canary" };
  }
  return {
    candidate: {
      ...nextRevision(candidate, "promoted", "promotion_gate_passed", now, {
        actor: "automatic-promotion-gate",
        evidenceRefs: evidence.evidenceRefs,
      }),
      evidenceGrade: evidence.grade,
      evidenceRefs: Array.from(
        new Set([...candidate.evidenceRefs, ...evidence.evidenceRefs]),
      ),
    },
    changed: true,
    reason: "promotion_gate_passed",
  };
}

export function applyManualPromotionOverride(
  candidate: CandidateAsset,
  input: { actor: string; reason: string; evidenceRefs: string[] },
  now: string = new Date().toISOString(),
): CandidateLifecycleDecision {
  if (candidate.type !== "memory") {
    return {
      candidate,
      changed: false,
      reason: "non_memory_activation_forbidden",
    };
  }
  if (
    !input.actor.trim() ||
    !input.reason.trim() ||
    input.evidenceRefs.length === 0
  ) {
    return {
      candidate,
      changed: false,
      reason: "manual_override_audit_required",
    };
  }
  const promoted = nextRevision(candidate, "promoted", input.reason, now, {
    actor: input.actor,
    evidenceRefs: input.evidenceRefs,
  });
  return {
    candidate: promoted,
    changed: true,
    reason: "manual_override",
    override: {
      actor: input.actor,
      reason: input.reason,
      evidenceRefs: [...input.evidenceRefs],
      previousRevisionId: candidate.revisionId,
    },
  };
}

export function evaluateDependencyDrift(
  candidate: CandidateAsset,
  current: EvolutionDependencyFingerprint,
  now: string = new Date().toISOString(),
): CandidateLifecycleDecision {
  const changedDependencies = DEPENDENCY_KEYS.filter((key) => {
    const expected = candidate.dependencies[key];
    return (
      expected != null && current[key] != null && expected !== current[key]
    );
  });
  if (changedDependencies.length === 0) {
    return { candidate, changed: false, reason: "dependencies_unchanged" };
  }
  if (candidate.lifecycle === "retired" || candidate.lifecycle === "rejected") {
    return { candidate, changed: false, reason: "candidate_inactive" };
  }
  const reason = `dependency_drift:${changedDependencies.join(",")}`;
  return {
    candidate: nextRevision(candidate, "needs_revalidation", reason, now, {
      actor: "dependency-drift-detector",
    }),
    changed: true,
    reason,
  };
}

export function retireCandidate(
  candidate: CandidateAsset,
  reason: string,
  now: string = new Date().toISOString(),
  actor: string = "system",
): CandidateLifecycleDecision {
  if (!reason.trim()) {
    return { candidate, changed: false, reason: "retirement_reason_required" };
  }
  return {
    candidate: nextRevision(candidate, "retired", reason, now, { actor }),
    changed: true,
    reason,
  };
}
