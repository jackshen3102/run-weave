import type { TerminalRuntimePreference } from "./terminal-protocol";
import type { AgentTeamWorkerRole } from "./agent-team-worker";
import type {
  AgentTeamAgentIntervention,
} from "./agent-team-intervention";

export type {
  AgentTeamAgentIntervention,
  AgentTeamAgentInterventionAction,
  InterveneAgentTeamRunRequest,
} from "./agent-team-intervention";
export type { AgentTeamWorkerRole } from "./agent-team-worker";

/**
 * Agent-team / loop-engineer data model. This replaces the retired
 * orchestrator module. A terminal == one run; workers are tmux panes inside
 * that terminal's session.
 */

export type AgentTeamPhase = "intake" | "proposal" | "executing";

export type AgentTeamStatus =
  | "clarifying"
  | "running"
  | "need_human"
  | "done"
  | "failed";

/** Worker role catalog — mirrors the prototype's role dots. */
export interface AgentTeamAcceptanceEvidence {
  type:
    | "screenshot"
    | "dom"
    | "text"
    | "command"
    | "event"
    | "json"
    | "log"
    | "code";
  /** Short human-facing title, e.g. "状态推送". */
  label: string;
  /** One-line human-facing explanation. */
  summary: string;
  /** Optional extra detail for expanded evidence views. */
  detail?: string;
  /** Raw evidence pointer or text. */
  ref: string;
}

export type AgentTeamAcceptanceStatus = "pass" | "fail" | "pending";
export type AgentTeamAcceptanceSource =
  | "test_case_file"
  | "plan_file_generated"
  | "task_generated";

export interface AgentTeamVerificationConfig {
  planFilePath?: string | null;
  testCaseFilePath?: string | null;
  generatedTestCaseFilePath?: string | null;
  planSha256?: string | null;
  testCaseSha256?: string | null;
  generatedTestCaseSha256?: string | null;
  acceptanceSource: AgentTeamAcceptanceSource;
}

export type AgentTeamReviewCheckpointMode = "disabled" | "local_commit";
export type AgentTeamReviewScope = "full" | "incremental" | "final";

/** Execution entry order: write-first or behavior-verification-first. */
export type AgentTeamFlow = "code_first" | "verify_first";

export interface AgentTeamReviewTarget {
  scope: AgentTeamReviewScope;
  baseCommit: string;
  /** Exact committed HEAD covered by a final review target. */
  targetCommit?: string | null;
  targetTree: string;
  changedPaths: string[];
  planSha256: string | null;
  testCaseSha256: string | null;
  requestedAt: string;
}

export interface AgentTeamReviewCheckpoint {
  sequence: number;
  commit: string;
  parentCommit: string;
  tree: string;
  reviewRound: number;
  reviewerPanelId: string | null;
  createdAt: string;
}

export interface AgentTeamReviewCheckpointState {
  mode: "local_commit";
  repoRoot: string;
  originalBranch: string;
  branch: string;
  taskBaseCommit: string;
  lastReviewedCommit: string;
  pendingReview: AgentTeamReviewTarget | null;
  checkpoints: AgentTeamReviewCheckpoint[];
  finalReviewedCommit: string | null;
}

/** A single markdown acceptance case, drafted at proposal, tracked in loop. */
export interface AgentTeamAcceptanceCase {
  caseId: string;
  text: string;
  sourceCaseId?: string | null;
  sourceFilePath?: string | null;
  sourceHeading?: string | null;
  tags?: string[];
  dependsOn?: string[];
  lastRunStatus?: "pass" | "fail" | "skipped" | "pending";
  skipReason?: string | null;
  /** Latest per-case conclusion supplied by the verification worker. */
  resultSummary?: string | null;
  /** Latest observed status from the behavior_verify worker. */
  status: AgentTeamAcceptanceStatus;
  /** Consecutive stable-fail rounds (debounce state); reset on pass/flip. */
  consecutiveFail: number;
  evidence: AgentTeamAcceptanceEvidence[];
  /** Which code pane the failure was bounced back to, if any. */
  bouncedToPanelId?: string | null;
  /** Recheck dispatch metadata; used by the backend watchdog to detect stuck workers. */
  recheckRequestedAt?: string | null;
  /** Dispatch that owns this recheck; stale dispatches must not be retried. */
  recheckDispatchId?: string | null;
  recheckWorkerPanelId?: string | null;
  recheckWorkerRole?: AgentTeamWorkerRole | null;
  recheckOutboxMtimeMs?: number | null;
  recheckAttempt?: number;
}

export type AgentTeamFindingVerificationMode = "runtime" | "structural";

export interface AgentTeamRepairCycle {
  repairKey: string;
  sourceRole: "code_review" | "behavior_verify";
  caseIds: string[];
  invariant: string;
  verificationMode: AgentTeamFindingVerificationMode;
  /** Reviewer/case evidence refs that a structural repair must reproduce. */
  sourceEvidenceRefs?: string[];
  attempts: number;
  maxAttempts: number;
  firstFailedRound: number;
  lastFailedRound: number;
  lastFailureSummary: string;
  /** Exact reviewer finding and outbox retained for a later human disposition. */
  finding?: AgentTeamOutboxFinding;
  reviewTarget?: AgentTeamReviewTarget | null;
  reviewOutbox?: AgentTeamWorkerOutbox;
}

export interface AgentTeamLoop {
  round: number;
  noProgressCount: number;
  maxNoProgress: number; // default 3
  escalated: boolean;
  lastReason: string | null;
  /** Debounce threshold: consecutive stable-fail rounds before a case counts. */
  stableFailThreshold: number; // default 2
  /** Normalized signatures of failures, for "same error repeats" detection. */
  errorFingerprints: string[];
  /** Highest acceptance pass count observed so far (objective progress signal). */
  bestPassCount: number;
  /** Independent repair budgets; diffs and verifier timeouts do not reset them. */
  repairCycles: AgentTeamRepairCycle[];
  maxRepairAttempts: number; // default 3
}

export interface AgentTeamWorker {
  id: string;
  role: AgentTeamWorkerRole;
  intent: string;
  /** tmux panel id bound after split; null before executing. */
  panelId?: string | null;
  tmuxPaneId?: string | null;
  /** Whether the orchestration layer is currently injecting rounds into it. */
  frozen?: boolean;
}

export interface AgentTeamProposal {
  summary: string;
  workers: AgentTeamWorker[];
  acceptance: AgentTeamAcceptanceCase[];
  /** Whether the proposal was produced by the agent (rw propose-split) or a human. */
  source: "user" | "agent";
}

export interface AgentTeamClarifyMessage {
  from: "agent" | "human";
  text: string;
  at: string;
}

export interface HumanInterventionNote {
  id: string;
  at: string;
  text: string;
  /** Fingerprints cleared by this intervention. */
  clearedFingerprints: string[];
  /** Repair cycles archived before the human resumed the run. */
  clearedRepairCycles?: AgentTeamRepairCycle[];
}

export interface AgentTeamRunOptions {
  autoApproveSplit: boolean;
  /** Notify the main Agent once when the run enters a Human Gate. */
  notifyMainOnHumanGate: boolean;
  reviewCheckpointMode?: AgentTeamReviewCheckpointMode;
  maxRepairAttempts?: number;
  /** Execution entry order; defaults to code_first when absent. */
  flow?: AgentTeamFlow;
}

/** Persisted freshness boundary for the worker currently allowed to complete. */
export interface AgentTeamActiveWorkerDispatch {
  /** Unique identity for this backend-owned dispatch. */
  dispatchId?: string;
  /** Absent on persisted legacy dispatches whose worker prompt had no dispatch id. */
  outboxDispatchIdRequired?: boolean;
  role: AgentTeamWorkerRole;
  panelId: string | null;
  tmuxPaneId: string | null;
  /** Loop round at dispatch time; absent on runs persisted before round attribution. */
  round?: number;
  requestedAt: string;
  /** null means the pane-scoped outbox did not exist when work was dispatched. */
  outboxMtimeMs: number | null;
  reviewTarget?: AgentTeamReviewTarget | null;
  /** Commit the behavior worker must verify for this exact dispatch. */
  verifiedCheckpointCommit?: string | null;
  /** Exact dirty paths accepted for this exact behavior dispatch. */
  checkpointAllowedDirtyPaths?: string[];
  /** Rewritten checkpoint commit whose trailers match the persisted checkpoint. */
  checkpointRebasedCommit?: string | null;
  /** Backend-owned repair identities expected from a bounced code worker. */
  repairKeys?: string[];
  /** One protocol-only correction is allowed before escalating to a human. */
  protocolCorrectionAttempt?: number;
  /** Source snapshot captured before a protocol-only outbox correction. */
  protocolCorrectionSourceFingerprint?: AgentTeamSourceFingerprint | null;
}

export interface AgentTeamSourceFingerprint {
  repoRoot: string;
  sha256: string;
}

export interface AgentTeamConsumedWorkerDispatchReceipt {
  dispatchId: string;
  role: AgentTeamWorkerRole;
  round: number;
  contentSha256: string;
  consumedAt: string;
}

export interface AgentTeamRun {
  runId: string;
  projectId: string;
  /** One terminal = one run. */
  terminalSessionId: string;
  /** The main-agent pane inside the terminal session. */
  mainPanelId?: string | null;
  phase: AgentTeamPhase;
  status: AgentTeamStatus;
  options: AgentTeamRunOptions;
  /** Agent CLI used by the root engineer and worker panes. */
  terminal: AgentTeamTerminal;
  task: string;
  verification?: AgentTeamVerificationConfig | null;
  reviewCheckpoint?: AgentTeamReviewCheckpointState | null;
  /** The only worker role currently allowed to do work in the serial flow. */
  activeWorkerRole?: AgentTeamWorkerRole | null;
  /** Identifies the current dispatch and separates its result from stale outboxes. */
  activeWorkerDispatch?: AgentTeamActiveWorkerDispatch | null;
  /** Present on runs that require every newly dispatched outbox to echo dispatchId. */
  workerDispatchProtocolVersion?: 1;
  /** Durable receipts for dispatches whose state-machine effect has completed. */
  consumedWorkerDispatches?: AgentTeamConsumedWorkerDispatchReceipt[];
  clarify: AgentTeamClarifyMessage[];
  proposal: AgentTeamProposal | null;
  workers: AgentTeamWorker[];
  acceptance: AgentTeamAcceptanceCase[];
  loop: AgentTeamLoop;
  humanNotes: HumanInterventionNote[];
  /** Recovery actions chosen by the main Agent through the control plane. */
  agentInterventions?: AgentTeamAgentIntervention[];
  /** Durable, review-target-scoped human decisions; never rewrites finding facts. */
  findingDecisions?: AgentTeamFindingDecision[];
  /** Reviewer result currently paused for an explicit scope/risk decision. */
  pendingFindingDecision?: AgentTeamPendingFindingDecision | null;
  /** Observation log for the executing sidecar. */
  logs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentTeamTerminal {
  command?: string;
  args?: string[];
  cwd?: string | null;
  runtimePreference?: TerminalRuntimePreference;
}

/** Worker outbox schema, extended with per-case acceptance results. */
export type AgentTeamOutboxStatus = "completed" | "failed";
export type AgentTeamFindingStatus = "open" | "resolved" | "informational";
export type AgentTeamFindingSeverity = "P0" | "P1" | "P2" | "P3";
export type AgentTeamFindingDisposition =
  | "blocking"
  | "out_of_scope"
  | "waived";

export interface AgentTeamFindingCaseImpact {
  /** Backend acceptance case id, not the source markdown heading id. */
  caseId: string;
  /** Why this finding violates the selected product case. */
  summary: string;
  /** Evidence that connects the reproduced scenario to this product case. */
  evidence: AgentTeamAcceptanceEvidence[];
}

export interface AgentTeamReviewFindingReproduction {
  mode: AgentTeamFixReproductionMode;
  status: AgentTeamFixReproductionStatus;
  scenarioId?: string | null;
  validationSessionId?: string | null;
  steps: string[];
  expected: string;
  actual: string;
  evidence: AgentTeamAcceptanceEvidence[];
}

export interface AgentTeamOutboxFinding {
  severity: AgentTeamFindingSeverity;
  status?: AgentTeamFindingStatus;
  title: string;
  summary: string;
  ref?: string;
  /** Stable system invariant identity for P0/P1 repair accounting. */
  invariantKey?: string;
  verificationMode?: AgentTeamFindingVerificationMode;
  /** Executed reviewer reproduction; required for every open P0/P1. */
  reproduction?: AgentTeamReviewFindingReproduction;
  /** Reviewer proposal. Only a recorded human decision can authorize non-blocking. */
  disposition?: AgentTeamFindingDisposition;
  /** Product cases observably affected by this finding. */
  caseImpacts?: AgentTeamFindingCaseImpact[];
}

export interface AgentTeamFindingDecision {
  id: string;
  invariantKey: string;
  scenarioId: string | null;
  /** Immutable finding snapshot; disposition never replaces the observed fact. */
  finding: AgentTeamOutboxFinding;
  disposition: AgentTeamFindingDisposition;
  caseIds: string[];
  reason: string;
  decidedAt: string;
  reviewTarget: AgentTeamReviewTarget | null;
}

export interface AgentTeamPendingFindingDecision {
  id: string;
  finding: AgentTeamOutboxFinding;
  outbox: AgentTeamWorkerOutbox;
  reviewTarget: AgentTeamReviewTarget | null;
  reason: string;
  requestedAt: string;
}

export type AgentTeamFixReproductionMode =
  | "real_product"
  | "review_harness"
  | "static_contract";
export type AgentTeamFixReproductionStatus =
  | "reproduced"
  | "confirmed"
  | "not_reproduced"
  | "boundary"
  | "blocked";
export type AgentTeamFixCheckDimension =
  | "positive"
  | "negative"
  | "temporal"
  | "concurrent"
  | "regression";

export interface AgentTeamFixVerification {
  repairKey: string;
  invariant: string;
  reproduction: {
    mode: AgentTeamFixReproductionMode;
    status: AgentTeamFixReproductionStatus;
    scenarioId?: string | null;
    validationSessionId?: string | null;
    evidence: AgentTeamAcceptanceEvidence[];
  };
  verification: {
    status: "pass" | "fail" | "blocked";
    sameScenario: boolean;
    evidence: AgentTeamAcceptanceEvidence[];
  };
  impactedChecks: Array<{
    label: string;
    dimension: AgentTeamFixCheckDimension;
    status: "pass" | "fail" | "skipped";
    summary: string;
    evidence: AgentTeamAcceptanceEvidence[];
  }>;
  strategyAssessment?: string | null;
}

export interface AgentTeamOutboxRecommendation {
  severity?: AgentTeamFindingSeverity;
  summary: string;
}

export interface AgentTeamWorkerOutbox {
  schemaVersion?: 1;
  /** Echoes the backend-owned active dispatch; absent only for legacy prompts. */
  dispatchId?: string | null;
  sessionId: string;
  panelId?: string | null;
  tmuxPaneId?: string | null;
  projectId?: string | null;
  runId?: string | null;
  role?: string | null;
  status: AgentTeamOutboxStatus;
  summary: string;
  error: string | null;
  completionReason?: string | null;
  finishedAt: string;
  reviewTarget?: AgentTeamReviewTarget | null;
  verifiedCheckpointCommit?: string | null;
  findings?: AgentTeamOutboxFinding[];
  resolvedFindings?: AgentTeamOutboxFinding[];
  remainingFindings?: AgentTeamOutboxFinding[];
  recommendations?: AgentTeamOutboxRecommendation[];
  /** Code-worker evidence handoff for backend-owned repair keys. */
  fixVerifications?: AgentTeamFixVerification[];
  acceptanceResults?: Array<{
    caseId: string;
    status: "pass" | "fail" | "skipped";
    summary?: string | null;
    skipReason?: string | null;
    evidence: AgentTeamAcceptanceEvidence[];
  }>;
}

export interface AgentTeamAcceptanceDraft {
  caseId?: string | null;
  text: string;
  sourceCaseId?: string | null;
  sourceFilePath?: string | null;
  sourceHeading?: string | null;
  tags?: string[];
  dependsOn?: string[];
}

// --- request / response DTOs ---

export interface CreateAgentTeamRunRequest {
  projectId: string;
  terminalSessionId: string;
  task?: string;
  planFilePath?: string | null;
  testCaseFilePath?: string | null;
  options?: Partial<AgentTeamRunOptions>;
  /**
   * Defaults to Codex for the current loop-engineer test path. Callers may
   * override this later without changing the orchestration flow.
   */
  terminal?: AgentTeamTerminal;
}

export interface ProposeAgentTeamSplitRequest {
  /** Who triggered the proposal: human button or agent self-judgment. */
  source?: "user" | "agent";
  summary?: string;
  workers?: Array<Pick<AgentTeamWorker, "role" | "intent">>;
  acceptance?: AgentTeamAcceptanceDraft[];
  planFilePath?: string | null;
  testCaseFilePath?: string | null;
  generatedTestCaseFilePath?: string | null;
}

export interface SubmitAgentTeamSplitGateRequest {
  verdict: "confirmed" | "rejected";
  workers?: Array<Pick<AgentTeamWorker, "role" | "intent">>;
  acceptance?: AgentTeamAcceptanceDraft[];
  planFilePath?: string | null;
  testCaseFilePath?: string | null;
  generatedTestCaseFilePath?: string | null;
}

export interface ResumeAgentTeamRunRequest {
  note: string;
}

export interface CompleteAgentTeamRunRequest {
  note?: string;
}

export interface DecideAgentTeamFindingRequest {
  invariantKey: string;
  disposition: AgentTeamFindingDisposition;
  caseIds?: string[];
  reason: string;
}

export interface FocusAgentTeamPaneRequest {
  panelId: string;
}

export interface AgentTeamRunsResponse {
  runs: AgentTeamRun[];
}

export type AgentTeamExportHistoryMode = "none" | "tail" | "full";

export interface AgentTeamExportPanel {
  panelId: string;
  tmuxPaneId: string | null;
  alias: string | null;
  role: string | null;
  workerRole: AgentTeamWorkerRole | "main" | "unknown";
  workerId: string | null;
  source: "main" | "worker" | "session-other";
  history?: {
    mode: "tail" | "full" | "unavailable";
    tailLines: number | null;
    scrollback: string | null;
    error?: string;
  };
}

export interface AgentTeamExportOutbox {
  path: string;
  exists: boolean;
  scope: "panel" | "tmux-pane" | "legacy-session";
  panelId: string | null;
  tmuxPaneId: string | null;
  outbox: AgentTeamWorkerOutbox | null;
  error?: string;
}

/** Immutable observation of one pane outbox before the state machine consumes it. */
export interface AgentTeamOutboxHistoryRecord {
  schemaVersion: 1;
  runId: string;
  round: number;
  dispatchId: string;
  role: AgentTeamWorkerRole;
  panelId: string | null;
  tmuxPaneId: string | null;
  requestedAt: string;
  recordedAt: string;
  sourcePath: string;
  sourceMtimeMs: number;
  contentSha256: string;
  /** Exact file content observed by the backend. */
  rawContent: string;
  /** Normalized payload used by the state machine. */
  outbox: AgentTeamWorkerOutbox;
}

export interface AgentTeamExportOutboxHistory {
  path: string;
  record: AgentTeamOutboxHistoryRecord | null;
  error?: string;
}

export interface AgentTeamExportAcceptanceSummary {
  caseId: string;
  status: AgentTeamAcceptanceStatus;
  evidenceCount: number;
  sourceRoles: string[];
  remainingFindingCount: number;
  resolvedFindingCount: number;
}

export interface AgentTeamExportResponse {
  run: AgentTeamRun;
  generatedAt: string;
  projectRoot: string | null;
  panels: {
    runBound: AgentTeamExportPanel[];
    sessionOther: AgentTeamExportPanel[];
  };
  outboxes: AgentTeamExportOutbox[];
  outboxHistory: AgentTeamExportOutboxHistory[];
  acceptanceSummary: AgentTeamExportAcceptanceSummary[];
  warnings: string[];
}
