import { createHash } from "node:crypto";
import type {
  CandidateApplicability,
  CandidateAsset,
  CandidateExclusions,
  CandidateRisk,
  CandidateType,
  EvolutionDependencyFingerprint,
} from "@runweave/shared/evolution";

export interface CandidateDraftInput {
  type: CandidateType;
  learningScopeId: string;
  insightRevisionId: string;
  statement: string;
  guidance: string;
  rationale: string;
  evidenceRefs: string[];
  counterEvidenceRefs: string[];
  applicability: CandidateApplicability;
  exclusions?: CandidateExclusions;
  dependencies?: EvolutionDependencyFingerprint;
  risk: CandidateRisk;
  validFrom?: string;
  expiresAt?: string | null;
}

const GENERATOR_VERSION = "candidate-factory-v1";

function stableId(prefix: string, values: string[]): string {
  return `${prefix}_${createHash("sha256")
    .update(values.join("\n"))
    .digest("hex")
    .slice(0, 20)}`;
}

export function createCandidateAsset(
  input: CandidateDraftInput,
  now: string = new Date().toISOString(),
): CandidateAsset {
  if (input.evidenceRefs.length === 0) {
    throw new Error("candidate_evidence_required");
  }
  if (input.applicability.workerRoles.length === 0) {
    throw new Error("candidate_worker_scope_required");
  }
  const assetId = stableId("asset", [
    input.learningScopeId,
    input.type,
    input.insightRevisionId,
    input.statement,
  ]);
  const revisionId = stableId("arev", [
    assetId,
    input.insightRevisionId,
    input.guidance,
    JSON.stringify(input.evidenceRefs),
    JSON.stringify(input.counterEvidenceRefs),
  ]);
  return {
    assetId,
    revisionId,
    type: input.type,
    lifecycle: input.type === "memory" ? "shadow" : "draft",
    learningScopeId: input.learningScopeId,
    insightRevisionId: input.insightRevisionId,
    statement: input.statement,
    guidance: input.guidance,
    rationale: input.rationale,
    evidenceGrade: "E1",
    evidenceRefs: [...input.evidenceRefs],
    counterEvidenceRefs: [...input.counterEvidenceRefs],
    applicability: {
      ...input.applicability,
      workerRoles: [...input.applicability.workerRoles],
    },
    exclusions: { ...input.exclusions },
    dependencies: { ...input.dependencies },
    risk: input.risk,
    generatorVersion: GENERATOR_VERSION,
    validFrom: input.validFrom ?? now,
    expiresAt: input.expiresAt ?? null,
    createdAt: now,
    updatedAt: now,
    lifecycleHistory: [
      {
        eventId: stableId("ale", [assetId, revisionId, "created"]),
        from: null,
        to: input.type === "memory" ? "shadow" : "draft",
        actor: GENERATOR_VERSION,
        reason:
          input.type === "memory"
            ? "memory_auto_shadow"
            : "proposal_only_asset",
        evidenceRefs: [...input.evidenceRefs],
        at: now,
      },
    ],
  };
}

export function createCandidateAssets(
  inputs: CandidateDraftInput[],
  now?: string,
): CandidateAsset[] {
  return inputs.map((input) => createCandidateAsset(input, now));
}
