import type { TerminalPreviewChangeFile, TerminalPreviewChangeKind, TerminalPreviewContentSide } from "./preview.js";

export type CodeReviewPhase = "preparing" | "starting" | "reviewing" | "completed" | "blocked" | "failed" | "cancelled";
export type CodeReviewDeliveryState = "not_ready" | "pending" | "writing" | "written" | "target_changed" | "unavailable" | "unknown";
export type CodeReviewCaseStatus = "open" | "passed" | "closed";
export interface CodeReviewExpectedTarget {
  projectId: string;
  threadId: string | null;
  provider: string | null;
}
export interface CreateCodeReviewRequest {
  requestId: string;
}
export interface CodeReviewSnapshotSide extends TerminalPreviewContentSide {
  /** Null means unavailable, never an invented empty file. */
  content: string | null;
  stamp: string;
}
export interface CodeReviewSnapshotEntry extends TerminalPreviewChangeFile {
  changeKind: TerminalPreviewChangeKind;
  old: CodeReviewSnapshotSide;
  new: CodeReviewSnapshotSide;
  omission: string | null;
}
export interface CodeReviewSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  head: string | null;
  rootPath: string;
  fingerprint: string;
  capturedAt: string;
  entries: CodeReviewSnapshotEntry[];
  omissions: string[];
}
export interface CodeReviewFinding {
  severity: "P0" | "P1" | "P2" | "P3";
  title: string;
  path: string;
  changeKind: TerminalPreviewChangeKind;
  side: "old" | "new";
  lineStart: number;
  lineEnd: number;
  impact: string;
  basis: "static" | "runtime";
  evidenceRefs: string[];
}
export interface CodeReviewCheck {
  description: string;
  status: "passed" | "failed" | "not_run";
  environment: string;
  observedResult: string;
  evidenceRefs: string[];
  /** Runtime checks require the before and after fingerprint of this range. */
  beforeFingerprint: string | null;
  afterFingerprint: string | null;
}
export interface CodeReviewArtifact {
  artifactId: string;
  /** Relative to this run's output directory. */
  path: string;
  mimeType: "text/plain" | "application/json" | "image/png" | "image/jpeg";
}
export interface CodeReviewReport {
  schemaVersion: 1;
  reviewId: string;
  snapshotId: string;
  fingerprint: string;
  summary: string;
  findings: CodeReviewFinding[];
  checks: CodeReviewCheck[];
  reviewedChanges: Array<{ path: string; changeKind: TerminalPreviewChangeKind }>;
  limitations: string[];
  coverageComplete: boolean;
  cleanup: string;
  artifacts: CodeReviewArtifact[];
}
export interface CodeReviewRun {
  reviewId: string;
  /** One case can contain multiple immutable snapshot/report rounds. */
  caseId: string;
  caseStatus: CodeReviewCaseStatus;
  round: number;
  requestId: string;
  projectId: string;
  phase: CodeReviewPhase;
  createdAt: string;
  updatedAt: string;
  reviewerTerminalId: string | null;
  reviewerPanelId: string | null;
  reportId: string | null;
  stale: boolean;
  delivery: CodeReviewDeliveryState;
  error: { code: string; message: string } | null;
  deliveryError: string | null;
  summary: string | null;
  findingCount: number | null;
}
export interface CodeReviewPage { runs: CodeReviewRun[]; before: string | null; target: { panelId: string | null; expectedTarget: CodeReviewExpectedTarget } | null }
export interface CodeReviewDetail {
  run: CodeReviewRun;
  snapshot: Omit<CodeReviewSnapshot, "entries"> & { entries: Array<Omit<CodeReviewSnapshotEntry, "old" | "new">> } | null;
  report: CodeReviewReport | null;
}
