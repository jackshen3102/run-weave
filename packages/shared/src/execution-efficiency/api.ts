import type {
  EfficiencyAnalysisRun,
  EfficiencyCoverage,
  EfficiencyDimension,
  EfficiencyFinding,
  EfficiencyFindingEvent,
  EfficiencyFindingEventAction,
  EfficiencyFindingStatus,
  EfficiencyObservation,
  EfficiencyTaskBinding,
} from "./types";

export interface ExecutionEfficiencyStatus {
  available: boolean;
  reason?: string;
  projectId: string;
  binding: EfficiencyTaskBinding | null;
  latestAnalysis: EfficiencyAnalysisRun | null;
  pendingQuestions: number;
}

export interface PutEfficiencyBindingRequest {
  projectId: string;
  taskId: string;
  expectedRevision: number;
}

export interface CollectEfficiencyRequest {
  projectId: string;
  scheduledRunId: string;
}

export interface EfficiencyCandidate {
  fingerprint: string;
  dimension: EfficiencyDimension;
  observationIds: string[];
  title: string;
  evidence: Array<{
    observationId: string;
    excerpt: string;
    measurement: EfficiencyObservation["measurement"];
  }>;
  question: string | null;
}

export interface CollectEfficiencyResponse {
  analysisId: string;
  evidenceVersion: number;
  candidates: EfficiencyCandidate[];
  questions: Array<{ findingId: string; question: string }>;
  coverage: EfficiencyCoverage;
  hasMore: boolean;
}

export interface SubmitEfficiencyDecision {
  fingerprint: string;
  verdict: "admit" | "dismiss";
  observationIds: string[];
  title: string;
  admissionReason: string;
  hypothesis: string;
  causeTags: string[];
  uncertainty: string;
  verification: string;
  /** Set only when explicitly adding evidence to an existing same-dimension record. */
  findingId?: string;
}

export interface SubmitEfficiencyResultRequest {
  evidenceVersion: number;
  decisions: SubmitEfficiencyDecision[];
  answers?: Array<{
    findingId: string;
    note: string;
    observationIds?: string[];
  }>;
}

export interface SubmitEfficiencyResultResponse {
  analysisId: string;
  accepted: number;
  dismissed: number;
  findingIds: string[];
}

export interface EfficiencyFindingFilter {
  projectId: string;
  dimension?: EfficiencyDimension;
  status?: EfficiencyFindingStatus;
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface EfficiencyFindingPage {
  items: Array<
    EfficiencyFinding & {
      measurement: EfficiencyObservation["measurement"];
    }
  >;
  nextCursor: string | null;
}

export interface EfficiencyFindingDetail extends EfficiencyFinding {
  observations: EfficiencyObservation[];
  events: EfficiencyFindingEvent[];
  source: {
    taskId: string | null;
    scheduledRunId: string | null;
    analysisId: string | null;
  };
}

export interface CreateEfficiencyFindingEventRequest {
  expectedRevision: number;
  action: EfficiencyFindingEventAction;
  note: string;
  verification?: string;
  confirmed?: boolean;
  observationIds?: string[];
}
