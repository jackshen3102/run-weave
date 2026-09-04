import {
  buildTerminalChildProjectIdPrefix,
  resolveTerminalParentProjectId,
} from "../terminal/project-context";
import type {
  ActivityActorType,
  ActivityEventName,
  ActivityPayload,
  ActivityResultStatus,
  ActivityRuntimeSurface,
} from "../activity/index";
import type { CandidateRisk, CandidateType } from "./activation";

export * from "./activation";

export type AnalysisProfile = "quick" | "standard" | "deep";

export type ProviderPolicy = "auto" | "codex" | "trae" | "mixed";

export const EVOLUTION_GLOBAL_SCOPE_ID = "global:runweave";

export type EvolutionReflectionScope =
  | { type: "global" }
  | { type: "project"; projectId: string };

export type LearningScopeRef =
  | {
      scopeType: "global";
      learningScopeId: typeof EVOLUTION_GLOBAL_SCOPE_ID;
      requestedProjectId: null;
      projectSelector: null;
    }
  | {
      scopeType: "project";
      learningScopeId: string;
      requestedProjectId: string;
      projectSelector: {
        exactProjectId: string;
        childProjectIdPrefix: string;
      };
    };

export type ContextPackSourceKind =
  | "activity"
  | "work_history"
  | "app_server"
  | "agent_team"
  | "knowledge_baseline"
  | "repository";

export interface SourceBoundary {
  sourceId: string;
  source: ContextPackSourceKind;
  afterWatermark: string | null;
  snapshotBoundary: string;
  processedThrough: string;
  digest: string;
  recordCount: number;
  truncated: boolean;
}

export interface DataQualityIssue {
  issueId: string;
  source: ContextPackSourceKind;
  code: string;
  severity: "warning" | "blocking";
  detail: string;
  evidenceIds: string[];
}

export interface ContextPackContentRef {
  contentId: string;
  sha256: string;
  availability: "available" | "unavailable";
  expectedExpiresAt: string;
  unavailableReason:
    | "expired"
    | "deleted"
    | "expires_before_run_deadline"
    | null;
}

export interface ContextPackEvidenceRef {
  evidenceId: string;
  source: ContextPackSourceKind;
  sourceRecordId: string;
  digest: string;
  availability: "available" | "unavailable";
  activity?: {
    activityOffset: number;
    eventName: ActivityEventName;
    occurredAt: string;
    producerName: string;
    actorType: ActivityActorType;
    runtimeSurface: ActivityRuntimeSurface;
    resultStatus: ActivityResultStatus | null;
    resultCode: string | null;
    payload: ActivityPayload;
  } | null;
  origin: {
    projectId: string | null;
    path: string | null;
    branch: string | null;
    revision: string | null;
  };
  relationships: {
    terminalSessionId: string | null;
    threadId: string | null;
    runId: string | null;
    interactionId: string | null;
    correlationId: string | null;
    causationId: string | null;
    parentEventId: string | null;
  };
  contentRefs: ContextPackContentRef[];
}

export interface ContextPackManifest {
  schemaVersion: 1;
  contextPackId: string;
  runId: string;
  learningScope: LearningScopeRef;
  profile: AnalysisProfile;
  baselineDigest: string;
  createdAt: string;
  deadlineAt: string;
  digest: string;
  sources: SourceBoundary[];
  evidence: ContextPackEvidenceRef[];
  dataQualityIssues: DataQualityIssue[];
}

export interface TraceSegment {
  segmentId: string;
  runId: string;
  learningScopeId: string;
  sequence: number;
  relationKind:
    | "agent_team_run"
    | "thread"
    | "terminal"
    | "interaction"
    | "standalone";
  relationId: string;
  evidenceIds: string[];
  createdAt: string;
}

export interface EpisodeEvidenceRef {
  evidenceId: string;
  segmentId: string;
  role: "fact" | "attempt" | "outcome" | "correction";
}

export interface Episode {
  episodeId: string;
  runId: string;
  learningScopeId: string;
  title: string;
  segmentIds: string[];
  evidence: EpisodeEvidenceRef[];
  boundaryConfidence: number;
  boundaryReason: string;
  createdAt: string;
}

export type AssessmentDimension =
  | "intent_understanding"
  | "goal_outcome"
  | "action_quality"
  | "self_correction"
  | "efficiency"
  | "safety";

export interface EvolutionAssessment {
  dimension: AssessmentDimension;
  value: "positive" | "negative" | "mixed" | "unknown";
  evidenceIds: string[];
  rationale: string;
}

export interface EvolutionObservedFact {
  factId: string;
  statement: string;
  evidenceIds: string[];
}

export type EvolutionAnalystRole =
  | "analyst_a"
  | "analyst_b"
  | "cross_examiner"
  | "judge";

export interface EvolutionReportClaim {
  topicKey: string;
  statement: string;
  scope: string;
  supportingEvidenceIds: string[];
  counterEvidenceIds: string[];
  candidateType: CandidateType | null;
  guidance: string | null;
  risk: CandidateRisk;
}

export interface EvolutionCrossReview {
  topicKey: string;
  status: ClaimStatus;
  counterEvidenceIds: string[];
  missingEvidence: string[];
  rationale: string;
}

export interface EvolutionAnalysisReport {
  reportId: string;
  runId: string;
  attemptNumber: number;
  role: EvolutionAnalystRole;
  provider: Extract<ProviderPolicy, "codex" | "trae">;
  summary: string;
  observedFacts: EvolutionObservedFact[];
  assessments: EvolutionAssessment[];
  claims: EvolutionReportClaim[];
  crossReviews: EvolutionCrossReview[];
  visibleReportIds: string[];
  createdAt: string;
}

export interface EvolutionRunAttempt {
  attemptId: string;
  runId: string;
  attemptNumber: number;
  role: EvolutionAnalystRole;
  provider: Extract<ProviderPolicy, "codex" | "trae">;
  selectionReason:
    | "explicit_policy"
    | "cross_provider"
    | "fallback_single_provider";
  status: "running" | "completed" | "failed" | "abandoned" | "cancelled";
  startedAt: string;
  completedAt: string | null;
  errorCode: string | null;
  reportId: string | null;
}

export type ClaimStatus =
  | "corroborated"
  | "contested"
  | "insufficient_evidence"
  | "rejected";

export interface EvolutionClaim {
  claimId: string;
  runId: string;
  learningScopeId: string;
  topicKey: string;
  statement: string;
  scope: string;
  status: ClaimStatus;
  supportingEvidenceIds: string[];
  counterEvidenceIds: string[];
  reportIds: string[];
  missingEvidence: string[];
  candidateType: CandidateType | null;
  guidance: string | null;
  risk: CandidateRisk;
  createdAt: string;
}

export type NoveltyClass =
  | "known"
  | "reinforced"
  | "novel"
  | "contradiction"
  | "drift";

export interface EvolutionClaimNovelty {
  claimId: string;
  novelty: NoveltyClass;
  baselineRevisionId: string | null;
  rationale: string;
}

export interface ContributionEdge {
  edgeId: string;
  insightRevisionId: string;
  evidenceId: string;
  relation: "supports" | "counters";
  availability: "available" | "unavailable";
  createdAt: string;
}

export interface InsightRevision {
  revisionId: string;
  insightId: string;
  runId: string;
  statement: string;
  scope: string;
  confidence: number;
  novelty: NoveltyClass;
  claimIds: string[];
  evidenceIds: string[];
  counterEvidenceIds: string[];
  createdAt: string;
}

export interface Insight {
  insightId: string;
  learningScopeId: string;
  topicKey: string;
  currentRevisionId: string;
  createdAt: string;
  updatedAt: string;
  revisions: InsightRevision[];
}

export interface EvolutionRunArtifacts {
  contextPack: ContextPackManifest | null;
  segments: TraceSegment[];
  episodes: Episode[];
  attempts: EvolutionRunAttempt[];
  reports: EvolutionAnalysisReport[];
  claims: EvolutionClaim[];
  novelty: EvolutionClaimNovelty[];
  insightRevisions: InsightRevision[];
  candidateIds: string[];
}

export function resolveEvolutionLearningScope(
  projectId: string,
): LearningScopeRef {
  const requestedProjectId = projectId.trim();
  if (!requestedProjectId) {
    throw new Error("evolution_project_id_required");
  }
  if (requestedProjectId === EVOLUTION_GLOBAL_SCOPE_ID) {
    return {
      scopeType: "global",
      learningScopeId: EVOLUTION_GLOBAL_SCOPE_ID,
      requestedProjectId: null,
      projectSelector: null,
    };
  }
  const learningScopeId = resolveTerminalParentProjectId(requestedProjectId);
  return {
    scopeType: "project",
    learningScopeId,
    requestedProjectId,
    projectSelector: {
      exactProjectId: learningScopeId,
      childProjectIdPrefix: buildTerminalChildProjectIdPrefix(learningScopeId),
    },
  };
}

export interface EvolutionBudget {
  maxAgents: number;
  maxModelTurns: number;
  maxWallTimeMs: number;
  maxContextBytes: number;
  maxToolCalls: number;
  maxReplays: number;
}

export type EvolutionTrigger =
  | { type: "manual"; requestedBy: string }
  | { type: "schedule"; scheduleId: string; dueAt: string }
  | { type: "event"; eventKey: string; sourceRef: string };

export type EvolutionRunStage =
  | "queued"
  | "snapshotting"
  | "segmenting"
  | "independent_analysis"
  | "cross_questioning"
  | "adjudicating"
  | "novelty_check"
  | "validating"
  | "completed"
  | "no_material_novelty"
  | "partial"
  | "failed"
  | "cancelled"
  | "blocked";

export type EvolutionRunOutcome =
  | "completed"
  | "no_material_novelty"
  | "partial"
  | "failed"
  | "cancelled"
  | "blocked";

export interface EvolutionRunDataRange {
  afterWatermark: string | null;
  atOrBefore: string;
}

export interface EvolutionRun {
  runId: string;
  learningScopeId: string;
  trigger: EvolutionTrigger;
  profile: AnalysisProfile;
  providerPolicy: ProviderPolicy;
  budget: EvolutionBudget;
  dataRange: EvolutionRunDataRange;
  stage: EvolutionRunStage;
  outcome: EvolutionRunOutcome | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  attempt: number;
}

export interface CreateEvolutionRunRequest {
  projectId?: string;
  scope?: EvolutionReflectionScope;
  profile?: AnalysisProfile;
  providerPolicy?: ProviderPolicy;
  budget?: Partial<EvolutionBudget>;
  dataRange?: Partial<EvolutionRunDataRange>;
}

export interface EvolutionProviderAvailability {
  provider: Extract<ProviderPolicy, "codex" | "trae">;
  available: boolean;
  binaryAvailable: boolean;
  authenticated: boolean;
  version: string | null;
  reason: string | null;
  checkedAt: string;
}

export interface EvolutionSchedule {
  scheduleId: string;
  learningScopeId: string;
  name: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  profile: AnalysisProfile;
  providerPolicy: ProviderPolicy;
  budget: EvolutionBudget;
  dataWindow: string;
  nextDueAt: string | null;
  lastDueAt: string | null;
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEvolutionScheduleRequest {
  projectId: string;
  name: string;
  cronExpression: string;
  timezone: string;
  enabled?: boolean;
  profile?: AnalysisProfile;
  providerPolicy?: ProviderPolicy;
  budget?: Partial<EvolutionBudget>;
  dataWindow?: string;
}

export interface UpdateEvolutionScheduleRequest {
  name?: string;
  cronExpression?: string;
  timezone?: string;
  enabled?: boolean;
  profile?: AnalysisProfile;
  providerPolicy?: ProviderPolicy;
  budget?: Partial<EvolutionBudget>;
  dataWindow?: string;
}

export interface EvolutionWatermark {
  learningScopeId: string;
  source: string;
  value: string;
  runId: string;
  updatedAt: string;
}
