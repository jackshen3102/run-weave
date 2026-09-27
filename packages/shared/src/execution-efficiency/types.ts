export type EfficiencyDimension = "duration" | "tokens";
export type EfficiencyFindingStatus =
  | "pending"
  | "processing"
  | "resolved"
  | "deferred"
  | "dismissed";

export interface TokenUsageCounts {
  input: number | null;
  cachedInput: number | null;
  cacheWriteInput: number | null;
  output: number | null;
  reasoningOutput: number | null;
  total: number | null;
}

export interface TokenUsageSample extends TokenUsageCounts {
  line: number;
  observedAt: string;
  model: string | null;
  serviceTier: string | null;
}

export interface TokenMeasurement {
  kind: "token-windows";
  samples: number;
  occurrences: number;
  input: number | null;
  cachedInput: number | null;
  nonCachedInput: number | null;
  cacheWriteInput: number | null;
  output: number | null;
  reasoningOutput: number | null;
  total: number | null;
  model: string | null;
  serviceTier: string | null;
  boundary: string;
  callIds: string[];
  attribution: "shared-window" | "single-call" | "mixed";
}

export interface DurationMeasurement {
  kind: "elapsed" | "call-interval";
  seconds: number | null;
  targetSeconds: number | null;
  sampleCount: number;
  boundary: string;
  intervalCount: number;
  percentile95Seconds: null;
}

export type EfficiencyMeasurement = TokenMeasurement | DurationMeasurement;

export interface EfficiencySourceSpan {
  sessionFile: string;
  startLine: number;
  endLine: number;
  excerpt: string;
}

export interface EfficiencyObservation {
  id: string;
  repositoryId: string;
  projectId: string;
  threadId: string;
  turnId: string;
  dimension: EfficiencyDimension;
  sourceHash: string;
  sourceSpan: EfficiencySourceSpan;
  measurement: EfficiencyMeasurement;
  conditions: Record<string, string>;
  quality: {
    completeness: "complete" | "partial" | "unknown";
    warnings: string[];
  };
  observedAt: string;
}

export interface EfficiencyFinding {
  id: string;
  projectId: string;
  dimension: EfficiencyDimension;
  observationIds: string[];
  title: string;
  admissionReason: string;
  hypothesis: string;
  causeTags: string[];
  uncertainty: string;
  verification: string;
  status: EfficiencyFindingStatus;
  revision: number;
  hasNewEvidence: boolean;
  createdAt: string;
  updatedAt: string;
}

export type EfficiencyFindingEventAction =
  | "start-processing"
  | "resolve"
  | "defer"
  | "dismiss"
  | "reopen"
  | "add-note"
  | "ask-analysis"
  | "add-evidence";

export interface EfficiencyFindingEvent {
  id: string;
  findingId: string;
  action: EfficiencyFindingEventAction;
  note: string;
  verification: string | null;
  observationIds: string[];
  createdAt: string;
}

export interface EfficiencyAnalysisRun {
  id: string;
  projectId: string;
  taskId: string;
  scheduledRunId: string;
  threadId: string | null;
  policyVersion: string;
  evidenceVersion: number;
  status: "collected" | "submitted" | "interrupted";
  coverage: EfficiencyCoverage;
  resultCount: number;
  analysisUsage: TokenUsageCounts | null;
  analysisUsageCompleteness: "pending" | "complete" | "partial" | "unavailable";
  createdAt: string;
  submittedAt: string | null;
}

export interface EfficiencyCoverage {
  sessionsInspected: number;
  sessionsAccepted: number;
  observationsCreated: number;
  excluded: Record<string, number>;
  unknownReasons: string[];
  bytesRead: number;
  durationMs: number;
  backlog: boolean;
}

export interface EfficiencyCheckpoint {
  repositoryId: string;
  sessionId: string;
  fileGeneration: string;
  committedOffset: number;
  lastCompleteEventLine: number;
  counterBaseline: TokenUsageSample | null;
  pendingCalls: Array<{ callId: string; line: number }>;
  updatedAt: string;
}

export interface EfficiencyAnalysisDecision {
  evidenceFingerprint: string;
  policyVersion: string;
  verdict: "admit" | "dismiss";
  findingId: string | null;
  reason: string;
  decidedAt: string;
}

export interface EfficiencyTaskBinding {
  projectId: string;
  taskId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
