import type { TerminalRuntimePreference } from "./terminal-protocol";

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
export type AgentTeamWorkerRole =
  | "code"
  | "code_review"
  | "behavior_verify";

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
  acceptanceSource: AgentTeamAcceptanceSource;
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
  /** Latest observed status from the behavior_verify worker. */
  status: AgentTeamAcceptanceStatus;
  /** Consecutive stable-fail rounds (debounce state); reset on pass/flip. */
  consecutiveFail: number;
  evidence: AgentTeamAcceptanceEvidence[];
  /** Which code pane the failure was bounced back to, if any. */
  bouncedToPanelId?: string | null;
  /** Recheck dispatch metadata; used by the backend watchdog to detect stuck workers. */
  recheckRequestedAt?: string | null;
  recheckWorkerPanelId?: string | null;
  recheckWorkerRole?: AgentTeamWorkerRole | null;
  recheckOutboxMtimeMs?: number | null;
  recheckAttempt?: number;
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
}

export interface AgentTeamRunOptions {
  autoApproveSplit: boolean;
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
  /** The only worker role currently allowed to do work in the serial flow. */
  activeWorkerRole?: AgentTeamWorkerRole | null;
  clarify: AgentTeamClarifyMessage[];
  proposal: AgentTeamProposal | null;
  workers: AgentTeamWorker[];
  acceptance: AgentTeamAcceptanceCase[];
  loop: AgentTeamLoop;
  humanNotes: HumanInterventionNote[];
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

export interface AgentTeamOutboxFinding {
  severity: AgentTeamFindingSeverity;
  status?: AgentTeamFindingStatus;
  title: string;
  summary: string;
  ref?: string;
}

export interface AgentTeamOutboxRecommendation {
  severity?: AgentTeamFindingSeverity;
  summary: string;
}

export interface AgentTeamWorkerOutbox {
  schemaVersion?: 1;
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
  findings?: AgentTeamOutboxFinding[];
  resolvedFindings?: AgentTeamOutboxFinding[];
  remainingFindings?: AgentTeamOutboxFinding[];
  recommendations?: AgentTeamOutboxRecommendation[];
  acceptanceResults?: Array<{
    caseId: string;
    status: "pass" | "fail" | "skipped";
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

export interface RecordAgentTeamRoundRequest {
  /** Optional per-case results to fold into the loop (used by smoke/e2e). */
  acceptanceResults?: AgentTeamWorkerOutbox["acceptanceResults"];
  /** Force-mark this round's objective progress signal. */
  hadDiff?: boolean;
  /** UI-observed round baseline. Stale manual rounds are ignored. */
  expectedRound?: number;
}

export interface ResumeAgentTeamRunRequest {
  note: string;
}

export interface CompleteAgentTeamRunRequest {
  note?: string;
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
  acceptanceSummary: AgentTeamExportAcceptanceSummary[];
  warnings: string[];
}
