import type { TerminalRuntimePreference } from "./terminal-protocol";

/**
 * Agent-team / loop-engineer data model. This replaces the retired
 * orchestrator module. A terminal == one run; workers are tmux panes inside
 * that terminal's session.
 */

export type AgentTeamPhase = "clarify" | "proposal" | "executing";

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
  | "behavior_verify"
  | "plan"
  | "plan_review";

export interface AgentTeamAcceptanceEvidence {
  type: "screenshot" | "dom" | "text";
  ref: string;
}

export type AgentTeamAcceptanceStatus = "pass" | "fail" | "pending";

/** A single markdown acceptance case, drafted at proposal, tracked in loop. */
export interface AgentTeamAcceptanceCase {
  caseId: string;
  text: string;
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

export interface AgentTeamWorkerOutbox {
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
  acceptanceResults?: Array<{
    caseId: string;
    status: "pass" | "fail";
    evidence: AgentTeamAcceptanceEvidence[];
  }>;
}

// --- request / response DTOs ---

export interface CreateAgentTeamRunRequest {
  projectId: string;
  terminalSessionId: string;
  task?: string;
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
  acceptance?: Array<Pick<AgentTeamAcceptanceCase, "text">>;
}

export interface SubmitAgentTeamSplitGateRequest {
  verdict: "confirmed" | "rejected";
  workers?: Array<Pick<AgentTeamWorker, "role" | "intent">>;
  acceptance?: Array<Pick<AgentTeamAcceptanceCase, "text">>;
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

export interface FocusAgentTeamPaneRequest {
  panelId: string;
}

export interface AgentTeamRunsResponse {
  runs: AgentTeamRun[];
}
