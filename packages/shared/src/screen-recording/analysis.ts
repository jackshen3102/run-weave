import type { ScreenRecordingCapture, ScreenRecordingInterval } from './recording';

export const SCREEN_ANALYSIS_VERSION = 1 as const;
export type AnalysisActor = 'person' | 'agent' | 'mixed';
export type AnalysisFactState = 'discussed' | 'attempted' | 'progress' | 'agent-reported' | 'verified' | 'documented';
export interface AnalysisSpan { startMs: number; endMs: number; actor: AnalysisActor }
export interface AnalysisEvidence {
  id: string; source: 'screen' | 'agent'; occurredAtMs: number;
  captureID?: string; provider?: string; threadID?: string; eventID?: string;
  text?: string;
  kind?: 'assistant' | 'tool'; independentSuccess?: boolean;
}
export interface AnalysisCard {
  cardID: string; matterID: string; revision: number; title: string; summary: string;
  detail: string; actor: AnalysisActor; state: AnalysisFactState; projectID?: string;
  spans: AnalysisSpan[]; evidenceIDs: string[]; updatedAt: number;
}
export interface AnalysisManifest {
  batchID: string; deviceID: string; day: string; inputHash: string; promptVersion: string;
  startMs: number; endMs: number; captures: ScreenRecordingCapture[];
  intervals: ScreenRecordingInterval[]; context: AnalysisCard[]; evidence: AnalysisEvidence[];
  agentCoverage: 'unknown' | 'partial' | 'complete';
}
export interface AnalysisClaim {
  manifest: AnalysisManifest; workerID: string; generation: number; expiresAt: number; attempt: number;
}
export interface AnalysisResultCard {
  cardID: string | null; matterID: string | null; baseRevision: number | null;
  title: string; summary: string; detail: string; actor: AnalysisActor;
  state: AnalysisFactState; projectID: string | null; spans: AnalysisSpan[]; evidenceIDs: string[];
}
export interface AnalysisReplacement { cardID: string; baseRevision: number; targetIndexes: number[] }
export interface AnalysisResult {
  cards: AnalysisResultCard[]; observation: string;
  rewriteSpan?: { startMs: number; endMs: number } | null;
  replacements?: AnalysisReplacement[];
}
export interface AnalysisReceipt { operationID: string; batchID: string; revision: number; cardIDs: string[] }
export interface AnalysisStatus {
  keywordSearchVersion?: 1;
  analysisVersion: 1; deviceID: string; state: 'ready' | 'unavailable'; revision: number;
  queueCount: number; failedCount: number; days?: string[]; latestSuccessMs?: number; processedThroughMs?: number;
  agentCoverage: 'unknown' | 'partial' | 'complete';
}
export interface AnalysisExport {
  schemaVersion: 1; deviceID: string; day: string; timeZone: 'Asia/Shanghai';
  snapshotID: string; revision: number; generatedAt: number; sourceReadAt: number;
  coverage: 'complete' | 'partial' | 'unavailable'; missingIntervals: Array<AnalysisSpan & { reason: string; batchID?: string }>;
  cards: AnalysisCard[]; evidence: AnalysisEvidence[]; summary: string; contentHash: string;
  nextCursor?: string;
}
export type AnalysisMethod = 'analysisSearch' | 'analysisStatus' | 'analysisCards' | 'analysisCard' | 'analysisExport' |
  'claimAnalysis' | 'renewAnalysis' | 'commitAnalysis' | 'analysisReceipt' | 'retryAnalysis' |
  'analysisAgentCursor' | 'ingestAnalysisEvents' | 'failAnalysis' | 'analysisFrame' | 'resolveAnalysisCapture';

export interface AnalysisSearchRequest {
  q: string; from: string; to: string; limit?: number;
}
export interface AnalysisSearchItem {
  day: string; cardID: string; matterID: string; revision: number;
  title: string; summary: string; actor: AnalysisActor; state: AnalysisFactState;
  firstStartMs: number; lastEndMs: number; spanCount: number;
  matchedFields: Array<'title' | 'summary'>;
}
export interface AnalysisSearchResponse {
  schemaVersion: 1; deviceID: string; serverEpoch: string; revision: number;
  timeZone: 'Asia/Shanghai'; q: string; from: string; to: string;
  items: AnalysisSearchItem[]; hasMore: boolean;
}
