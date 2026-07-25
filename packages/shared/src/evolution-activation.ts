export type CandidateType =
  | "memory"
  | "prompt"
  | "skill"
  | "routing"
  | "product"
  | "code";

export type AssetLifecycle =
  | "draft"
  | "shadow"
  | "canary"
  | "promoted"
  | "needs_revalidation"
  | "retired"
  | "rejected";

export type EvidenceGrade = "E1" | "E2" | "E3" | "E4";

export type CandidateRisk = "low" | "medium" | "high";

export interface EvolutionDependencyFingerprint {
  sourceRevision?: string | null;
  protocolRevision?: string | null;
  provider?: string | null;
  model?: string | null;
  toolRevision?: string | null;
  systemPromptRevision?: string | null;
  evidenceRevision?: string | null;
}

export interface CandidateApplicability {
  workerRoles: string[];
  taskTerms?: string[];
  pathPrefixes?: string[];
  commandTerms?: string[];
  failureSignatures?: string[];
}

export interface CandidateExclusions {
  taskTerms?: string[];
  pathPrefixes?: string[];
  failureSignatures?: string[];
}

export interface CandidateLifecycleEvent {
  eventId: string;
  from: AssetLifecycle | null;
  to: AssetLifecycle;
  actor: string;
  reason: string;
  evidenceRefs: string[];
  at: string;
}

export interface CandidateAsset {
  assetId: string;
  revisionId: string;
  type: CandidateType;
  lifecycle: AssetLifecycle;
  learningScopeId: string;
  insightRevisionId: string;
  statement: string;
  guidance: string;
  rationale: string;
  evidenceGrade: EvidenceGrade;
  evidenceRefs: string[];
  counterEvidenceRefs: string[];
  applicability: CandidateApplicability;
  exclusions: CandidateExclusions;
  dependencies: EvolutionDependencyFingerprint;
  risk: CandidateRisk;
  generatorVersion: string;
  validFrom: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lifecycleHistory: CandidateLifecycleEvent[];
}

export interface EvolutionScopePolicy {
  learningScopeId: string;
  revision: number;
  memoryCanaryEnabled: boolean;
  canaryRate: number;
  maxInjectedAssets: number;
  maxInjectionBytes: number;
  autoPromotion: boolean;
  minimumPromotionGrade: Extract<EvidenceGrade, "E3" | "E4">;
  minimumPromotionSamples: number;
  updatedAt: string;
  updatedBy: string;
}

export interface EvolutionMemoryQuery {
  learningScopeId: string;
  runId: string;
  dispatchId: string;
  workerRole: string;
  task: string;
  intent: string;
  paths: string[];
  commands: string[];
  failureSignatures: string[];
  dependencies: EvolutionDependencyFingerprint;
}

export interface EvolutionSelectionDecision {
  assetId: string;
  revisionId: string;
  selected: boolean;
  reason: string;
  confidence: number;
}

export interface EvolutionAssetAssignment {
  assetId: string;
  revisionId: string;
  bucket: Extract<EvolutionAssignmentBucket, "control" | "canary">;
  assignmentHash: string;
}

export type EvolutionAssignmentBucket =
  | "not_eligible"
  | "disabled"
  | "control"
  | "canary";

export interface RuntimeTraceEvent {
  eventId: string;
  traceId: string;
  kind:
    | "retrieved"
    | "filtered"
    | "selected"
    | "assigned"
    | "exposed"
    | "agent_feedback"
    | "review_gate"
    | "behavior_gate"
    | "repair"
    | "user_correction"
    | "completed"
    | "cancelled"
    | "fail_open";
  at: string;
  detail: Record<string, unknown>;
}

export interface RuntimeTraceSummary {
  traceId: string;
  learningScopeId: string;
  runId: string;
  dispatchId: string;
  workerRole: string;
  taskDigest: string;
  policyRevision: number;
  selectorVersion: string;
  assignmentBucket: EvolutionAssignmentBucket;
  assignmentHash: string | null;
  assignments: EvolutionAssetAssignment[];
  retrievedRevisionIds: string[];
  filtered: Array<{
    revisionId: string;
    reason: string;
  }>;
  decisions: EvolutionSelectionDecision[];
  exposedRevisionIds: string[];
  failOpenReason: string | null;
  createdAt: string;
  events: RuntimeTraceEvent[];
}

export interface EvolutionContextResult {
  context: string | null;
  trace: RuntimeTraceSummary;
}

export interface CandidatePromotionEvidence {
  grade: EvidenceGrade;
  sampleCount: number;
  objectiveImprovement: boolean;
  criticalRegressionCount: number;
  evidenceRefs: string[];
}

export interface CandidateLifecycleDecision {
  candidate: CandidateAsset;
  changed: boolean;
  reason: string;
  override?: {
    actor: string;
    reason: string;
    evidenceRefs: string[];
    previousRevisionId: string;
  };
}
