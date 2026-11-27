export type TerminalPrWatchStatus = "watching" | "paused" | "settled" | "error";
export type TerminalPrWatchPauseReason =
  | "manual"
  | "draft_unconfirmed"
  | "wake_limit_reached"
  | "read_failed_limit"
  | "thread_changed";

export interface PrWatchCandidate {
  repoNameWithOwner: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
}

export interface TerminalPrWatchState extends PrWatchCandidate {
  watchId: string;
  terminalSessionId: string;
  panelId: string;
  threadId: string | null;
  threadProvider: string | null;
  status: TerminalPrWatchStatus;
  pauseReason: TerminalPrWatchPauseReason | null;
  headSha: string | null;
  commentWakeCount: number;
  consecutiveReadFailures: number;
  lastCheckedAt: string | null;
  lastWakeAt: string | null;
  lastSummary: string | null;
  revision: number;
}

export interface PrWatchResponse {
  watch: TerminalPrWatchState | null;
  candidatePr?: PrWatchCandidate | null;
  inputVersion?: string;
}
export interface StartPrWatchRequest {
  prNumber?: number;
  prUrl?: string;
  operationId: string;
}
export interface ChangePrWatchRequest {
  action: "pause" | "resume" | "confirm_empty_draft_and_deliver";
  expectedRevision: number;
  expectedInputVersion?: string;
}
