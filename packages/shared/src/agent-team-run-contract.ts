import type { TerminalRuntimePreference } from "./terminal-protocol";

export type AgentTeamPhase = "intake" | "proposal" | "executing";

export type AgentTeamStatus =
  | "clarifying"
  | "running"
  | "need_human"
  | "done"
  | "failed";

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

export interface AgentTeamRunOptions {
  autoApproveSplit: boolean;
  /** Notify the main Agent once when the run enters a Human Gate. */
  notifyMainOnHumanGate: boolean;
  reviewCheckpointMode?: AgentTeamReviewCheckpointMode;
  maxRepairAttempts?: number;
  /** Execution entry order; defaults to code_first when absent. */
  flow?: AgentTeamFlow;
}

export interface AgentTeamTerminal {
  command?: string;
  args?: string[];
  cwd?: string | null;
  runtimePreference?: TerminalRuntimePreference;
}
