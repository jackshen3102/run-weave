/** Versioned evidence contract. No free-form business payloads belong in events. */
export const QUALITY_LIMITS = { batchEvents: 64, batchBytes: 256 * 1024, queueEvents: 10_000, queueBytes: 2 * 1024 * 1024, retentionDays: 30, storageBytes: 100 * 1024 * 1024 } as const;
export const QUALITY_ACTIONS = ["terminal_send", "connection_recover", "backend_incident", "desktop_incident"] as const;
export const QUALITY_STAGES = ["started", "request_started", "response_received", "confirmed", "state_updated", "ui_updated", "rejected", "failed", "unknown", "cancelled"] as const;
export interface QualityEvent {
  seq: number; at: string; action: typeof QUALITY_ACTIONS[number]; stage: typeof QUALITY_STAGES[number];
  operationId: string; launchId: string; elapsedMs: number; appVersion: string; buildId: string;
  sourceRevision: string; sourceState: "clean" | "modified" | "unknown";
  terminalSessionId?: string; attemptId?: string; relatedOperationId?: string;
  failureCode?: string; status?: number; closeCode?: number;
}
export interface QualityRange { from: number; through: number; reason: "overflow" | "corruption" }
export interface QualityBatch {
  schemaVersion: 1; backendId: string; sourceId: string; streamId: string;
  client: "desktop" | "web" | "ios" | "backend"; uploadedAt: string;
  events: QualityEvent[]; droppedRanges: QualityRange[];
}
export interface QualityReceipt { ackThrough: number; acceptedCount: number; duplicateCount: number; receivedAt: string }
export interface QualityCapabilities { enabled: boolean; schemaVersion: 1; backendId: string | null; limits: typeof QUALITY_LIMITS }
export interface QualityEvidence extends QualityEvent {
  receiveId: number; receivedAt: string; backendId: string; sourceId: string; streamId: string;
  client: QualityBatch["client"]; projectId: string | null;
}
export interface QualityPage { schemaVersion: 1; epoch: string; events: QualityEvidence[]; nextCursor: string; hasMore: boolean; snapshotUpper: number }
/** Retained stages for exact operation identities, bounded by a persisted read checkpoint. */
export interface QualityContextRequest {
  schemaVersion: 1; backendId: string; readCursor: string;
  operations: Pick<QualityEvidence, "sourceId" | "launchId" | "action" | "operationId">[];
  after?: number; limit?: number;
}
export interface QualityContextPage {
  schemaVersion: 1; events: QualityEvidence[]; through: number; cleanedThrough: number; nextAfter: number | null;
}
export interface QualityCoverage {
  schemaVersion: 1; backendId: string; epoch: string; earliestReceiveId: number; latestReceiveId: number;
  cleanedThrough: number; earliestCursor: string; storageBytes: number; storageState: "available" | "storage_full";
  sources: { sourceId: string; streamId: string; client: QualityBatch["client"]; lastReceivedAt: string; ackThrough: number; droppedRanges: QualityRange[] }[];
  gaps: { kind: string; at: string; sourceId?: string }[];
  clientQueueState: "unknown"; offlineCoverage: "unknown";
  logSources: { kind: "backend" | "desktop"; state: "configured" | "unconfigured" }[];
}
export interface QualityIssue {
  issueId: string; groupKey: string; firstAt: string; lastAt: string;
  status: "open" | "observing" | "awaiting_confirmation" | "closed";
  attribution: "located" | "hypothesis"; summary: string; cause: string; supporting: string[];
  counterEvidence: string[]; gaps: string[]; impact: string; suggestion: string; nextAction: string;
  evidenceIds: number[]; fixVersion: string | null; nextReviewAt: string | null;
  verification: { at: string; version: string; result: string; evidenceIds: number[] }[];
}
export interface QualityLedger {
  schemaVersion: 1; revision: number; issues: QualityIssue[];
  readCursor: string | null; analysisCursor: string | null; pending: QualityEvidence[];
  lease: { runKey: string; expiresAt: string } | null; reports: { runKey: string; at: string; summary: string }[];
}
export interface QualityLatencyBucket {
  client: "desktop" | "web" | "ios";
  action: "terminal_send" | "connection_recover";
  appVersion: string;
  buildId: string;
  sourceRevision: string;
  sourceState: "clean" | "modified" | "unknown";
  firstAt: string;
  lastAt: string;
  count: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
  sampleEvidenceIds: number[];
}
export interface QualityLatencyBaselinesResponse {
  schemaVersion: 1;
  backendId: string;
  buckets: QualityLatencyBucket[];
}
/** Checkpoint pages before analysis; one expiring writer lease protects daily runs. */
export interface QualityLedgerCommit {
  schemaVersion: 1; backendId: string; runKey: string; commitKey: string; expectedRevision: number;
  phase: "acquire" | "checkpoint" | "analysis" | "release" | "recovery" | "mark_fixed" | "confirm_close";
  confirmedIssueIds?: string[];
  fixedIssueIds?: string[];
  fixVersion?: string;
  nextReviewAt?: string;
  readCursor?: string; analysisCursor?: string; pending?: QualityEvidence[]; issues?: QualityIssue[]; summary?: string;
}
export type QualityIssueHandoffTargetAgent = "codex" | "claude" | "pi" | "traex" | "agy";
export interface CreateQualityIssueHandoffRequest {
  operationId: string;
  targetProjectId: string;
  targetAgent: QualityIssueHandoffTargetAgent;
  prompt?: string;
  submitPrompt?: boolean;
  allowHypothesis?: boolean;
}
export interface CreateQualityIssueHandoffResponse {
  issueId: string;
  terminalSessionId: string;
  panelId: string;
  projectId: string;
  targetAgent: QualityIssueHandoffTargetAgent;
  handoffFilePath: string;
  includedEvidenceCount: number;
  expiredEvidenceCount: number;
  status: "delivered";
}
export function qualityCanonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)])) : item;
  return JSON.stringify(sort(value));
}
