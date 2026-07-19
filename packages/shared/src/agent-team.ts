import type { AgentTeamWorker, AgentTeamWorkerRole } from "./agent-team-worker";
import type { AgentTeamAgentIntervention } from "./agent-team-intervention";
import type { AgentTeamAcceptanceEvidence } from "./agent-team-evidence";
import type {
  AgentTeamAcceptanceDraft,
  AgentTeamAcceptanceSkip,
} from "./agent-team-acceptance";
import type {
  AgentTeamActiveWorkerDispatch,
  AgentTeamConsumedWorkerDispatchReceipt,
} from "./agent-team-dispatch";
import type {
  AgentTeamFixtureResourceCleanup,
  AgentTeamOwnedFixtureCleanup,
  AgentTeamRunCancellation,
  AgentTeamRunKind,
  AgentTeamRunLineage,
} from "./agent-team-fixture";
import type {
  AgentTeamAcceptanceDisposition,
  AgentTeamAcceptanceObservation,
  AgentTeamAcceptanceObservedOutcome,
  AgentTeamAcceptanceStatus,
  AgentTeamCompletionOutcome,
  AgentTeamPhase,
  AgentTeamReviewCheckpointState,
  AgentTeamReviewTarget,
  AgentTeamRunOptions,
  AgentTeamStatus,
  AgentTeamTerminal,
  AgentTeamVerificationConfig,
} from "./agent-team-run-contract";

export type {
  AgentTeamAgentIntervention,
  AgentTeamAgentInterventionAction,
  InterveneAgentTeamRunRequest,
} from "./agent-team-intervention";
export type { AgentTeamWorker, AgentTeamWorkerRole } from "./agent-team-worker";
export type { AgentTeamAcceptanceEvidence } from "./agent-team-evidence";
export type {
  AgentTeamAcceptanceSkip,
  AgentTeamAcceptanceSkipCode,
  AgentTeamAcceptanceDraft,
} from "./agent-team-acceptance";
export type {
  AgentTeamActiveWorkerDispatch,
  AgentTeamConsumedWorkerDispatchReceipt,
  AgentTeamSourceFingerprint,
} from "./agent-team-dispatch";
export type {
  AgentTeamFixtureDevSessionCleanup,
  AgentTeamFixtureResourceCleanup,
  AgentTeamFixtureResourceLedger,
  AgentTeamOwnedFixtureCleanup,
  AgentTeamRunCancellation,
  AgentTeamRunKind,
  AgentTeamRunLineage,
  CancelAgentTeamRunRequest,
  CleanupAgentTeamFixtureScopeRequest,
} from "./agent-team-fixture";
export type {
  AgentTeamAcceptanceDisposition,
  AgentTeamAcceptanceObservation,
  AgentTeamAcceptanceObservedOutcome,
  AgentTeamAcceptanceSource,
  AgentTeamAcceptanceStatus,
  AgentTeamCompletionException,
  AgentTeamCompletionOutcome,
  AgentTeamCompletionResult,
  AgentTeamFlow,
  AgentTeamPhase,
  AgentTeamReviewCheckpoint,
  AgentTeamReviewCheckpointMode,
  AgentTeamReviewCheckpointState,
  AgentTeamReviewScope,
  AgentTeamReviewTarget,
  AgentTeamRunOptions,
  AgentTeamStatus,
  AgentTeamTerminal,
  AgentTeamVerificationConfig,
} from "./agent-team-run-contract";

/**
 * Agent-team / loop-engineer data model. This replaces the retired
 * orchestrator module. A terminal == one run; workers are tmux panes inside
 * that terminal's session.
 */

/** A structured acceptance case loaded from a YAML test plan and tracked in loop. */
export interface AgentTeamAcceptanceCase {
  caseId: string;
  text: string;
  sourceCaseId?: string | null;
  sourceFilePath?: string | null;
  sourceHeading?: string | null;
  tags?: string[];
  dependsOn?: string[];
  lastRunStatus?: "pass" | "fail" | "skipped" | "pending";
  /** Latest completed observation. Pending is represented by absence. */
  latestObservation?: AgentTeamAcceptanceObservation | null;
  /** Machine-readable latest skip; skipReason remains a legacy display fallback. */
  skip?: AgentTeamAcceptanceSkip | null;
  skipReason?: string | null;
  /** Latest per-case conclusion supplied by the verification worker. */
  resultSummary?: string | null;
  /** Executed failure scenario supplied by behavior_verify. */
  reproduction?: AgentTeamReviewFindingReproduction | null;
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

export interface AgentTeamAcceptanceDecision {
  id: string;
  caseId: string;
  disposition: AgentTeamAcceptanceDisposition;
  reason: string;
  /** Immutable observation snapshot that this decision resolves. */
  observation: AgentTeamAcceptanceObservation;
  decidedAt: string;
}

export function resolveAgentTeamAcceptanceObservedOutcome(
  item: AgentTeamAcceptanceCase,
): AgentTeamAcceptanceObservedOutcome | "pending" {
  if (item.latestObservation) {
    return item.latestObservation.outcome;
  }
  if (item.lastRunStatus === "skipped" || item.skip) {
    return "skipped";
  }
  if (item.lastRunStatus === "pass" || item.status === "pass") {
    return "pass";
  }
  if (item.lastRunStatus === "fail" || item.status === "fail") {
    return "fail";
  }
  return "pending";
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
  /** Verifier-owned scenario that the code worker must reproduce unchanged. */
  sourceReproduction?: AgentTeamReviewFindingReproduction;
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

export type AgentTeamFrameworkRepairResult = "blocked" | "continued" | "rerun";

export interface AgentTeamFrameworkRepairTarget {
  role: AgentTeamWorkerRole;
  caseIds: string[];
  panelId: string | null;
  tmuxPaneId: string | null;
  invalidatedDispatch: AgentTeamActiveWorkerDispatch;
}

/** Persisted framework-repair boundary. A blocked record revokes old dispatches. */
export interface AgentTeamFrameworkRepair {
  repairId: string;
  reason: string;
  begunAt: string;
  backendInstanceIdBefore: string;
  target: AgentTeamFrameworkRepairTarget;
  result: AgentTeamFrameworkRepairResult;
  /** A durable dispatch reservation which may already have reached the Worker. */
  pendingContinueDispatchId?: string | null;
  continuedAt?: string | null;
  continuedDispatchId?: string | null;
  rerunAt?: string | null;
  successorRunId?: string | null;
}

export interface AgentTeamRun {
  runId: string;
  projectId: string;
  /** Missing on historical data and interpreted as primary. */
  runKind?: AgentTeamRunKind;
  /** Present only for verification_fixture runs. */
  lineage?: AgentTeamRunLineage | null;
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
  /** Framework repair gate and its final recovery decision, when present. */
  frameworkRepair?: AgentTeamFrameworkRepair | null;
  /** Links a clean rerun back to the framework-blocked run it replaced. */
  predecessorRunId?: string | null;
  /** Links a framework-blocked run to the clean rerun created from it. */
  successorRunId?: string | null;
  clarify: AgentTeamClarifyMessage[];
  proposal: AgentTeamProposal | null;
  workers: AgentTeamWorker[];
  acceptance: AgentTeamAcceptanceCase[];
  /** Append-only human decisions bound to an exact acceptance observation. */
  acceptanceDecisions?: AgentTeamAcceptanceDecision[];
  /** Current terminal result; null while the Run is non-terminal. */
  completionOutcome?: AgentTeamCompletionOutcome | null;
  /** Append-only terminal transition history. */
  completionHistory?: AgentTeamCompletionOutcome[];
  loop: AgentTeamLoop;
  humanNotes: HumanInterventionNote[];
  /** Recovery actions chosen by the main Agent through the control plane. */
  agentInterventions?: AgentTeamAgentIntervention[];
  /** Durable, review-target-scoped human decisions; never rewrites finding facts. */
  findingDecisions?: AgentTeamFindingDecision[];
  /** Reviewer result currently paused for an explicit scope/risk decision. */
  pendingFindingDecision?: AgentTeamPendingFindingDecision | null;
  /** Immutable reason for an auditable cancelled terminal state. */
  cancellation?: AgentTeamRunCancellation | null;
  /** Latest idempotent cleanup result for this fixture's owned resources. */
  fixtureResourceCleanup?: AgentTeamFixtureResourceCleanup | null;
  /** Parent-side cleanup receipts, retained across behavior dispatches. */
  fixtureCleanupHistory?: AgentTeamOwnedFixtureCleanup[];
  /** Observation log for the executing sidecar. */
  logs: string[];
  createdAt: string;
  updatedAt: string;
}

export function resolveAgentTeamAcceptanceDecision(
  run: AgentTeamRun,
  item: AgentTeamAcceptanceCase,
): AgentTeamAcceptanceDecision | null {
  const observation = item.latestObservation;
  if (!observation) {
    return null;
  }
  return (
    (run.acceptanceDecisions ?? [])
      .slice()
      .reverse()
      .find(
        (decision) =>
          decision.caseId === item.caseId &&
          decision.observation.outcome === observation.outcome &&
          decision.observation.dispatchId === observation.dispatchId &&
          decision.observation.recordedAt === observation.recordedAt,
      ) ?? null
  );
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
  /** Backend acceptance case id, not the source YAML case id. */
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
  /** Auditable proof that code invoked the mandatory reproduce-before-fix skill. */
  skillInvocation?: {
    name: "$toolkit:reproduce-before-fix";
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
    /** Required for skipped results produced by current behavior dispatches. */
    skip?: AgentTeamAcceptanceSkip | null;
    skipReason?: string | null;
    evidence: AgentTeamAcceptanceEvidence[];
    /** Required for behavior_verify failures. */
    reproduction?: AgentTeamReviewFindingReproduction;
  }>;
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

// --- request / response DTOs ---

export interface CreateAgentTeamRunRequest {
  projectId: string;
  terminalSessionId: string;
  runKind?: AgentTeamRunKind;
  lineage?: AgentTeamRunLineage | null;
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

export interface BeginAgentTeamFrameworkRepairRequest {
  reason: string;
}

export type AgentTeamFrameworkRepairContinueBlockerCode =
  | "backend_not_restarted"
  | "recovery_target_missing"
  | "worker_pane_unavailable"
  | "continue_dispatch_pending"
  | "repair_not_blocked";

export interface AgentTeamFrameworkRepairRecoveryStatus {
  runId: string;
  repairId: string;
  reason: string;
  result: AgentTeamFrameworkRepairResult;
  backendRestarted: boolean;
  canContinue: boolean;
  continueBlocker: {
    code: AgentTeamFrameworkRepairContinueBlockerCode;
    message: string;
  } | null;
  actions: Array<"continue" | "rerun">;
  target: AgentTeamFrameworkRepairTarget;
}

export interface AgentTeamFrameworkRepairResponse {
  run: AgentTeamRun;
  recovery: AgentTeamFrameworkRepairRecoveryStatus;
  successorRun: AgentTeamRun | null;
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

export interface DecideAgentTeamAcceptanceRequest {
  caseId: string;
  disposition: AgentTeamAcceptanceDisposition;
  reason: string;
}

export interface FocusAgentTeamPaneRequest {
  panelId: string;
}

export interface AgentTeamFixtureScopeResponse {
  ownerRunId: string;
  ownerDispatchId: string | null;
  runs: AgentTeamRun[];
  ownedLiveFixtureRuns: number;
}

export interface CleanupAgentTeamFixtureScopeResponse extends AgentTeamFixtureScopeResponse {
  cancelledRunIds: string[];
  cleanupErrors: Array<{ runId: string; errors: string[] }>;
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

export interface AgentTeamRunsResponse {
  runs: AgentTeamRun[];
}
