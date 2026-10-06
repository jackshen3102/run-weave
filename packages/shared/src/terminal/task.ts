import type { AppServerThreadDetailTurn } from "../app-server/events.js";
import type { TerminalState } from "./runtime/state.js";

/** Backend-scoped caller key. It is not a Dots internal task ID. */
export interface CreateTerminalTaskRequest {
  taskId: string;
  projectId: string;
  cwd: string;
  goal: string;
}

export interface TerminalTaskDispatch {
  dispatchId: string;
  text: string;
  wireText: string;
  delivery: "when_idle" | "queue";
  status: "delivery_unknown" | "written" | "received";
  sentAt: string;
  turnId: string | null;
  turnStatus: AppServerThreadDetailTurn["status"] | null;
  error?: string;
}

export interface TerminalTaskReview {
  reviewId: string;
  dispatchId: string;
  outcome: "accepted" | "changes_requested" | "blocked";
  summary: string;
  evidence: string[];
  createdAt: string;
}

export interface TerminalTask {
  taskId: string;
  projectId: string;
  cwd: string;
  goal: string;
  terminalSessionId: string | null;
  panelId: string | null;
  provider: "codex";
  threadId: string | null;
  launchOperationId: string | null;
  phase: "creating" | "created" | "starting" | "ready" | "unavailable";
  control: "supervisor" | "human";
  controlReason: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  dispatches: TerminalTaskDispatch[];
  reviews: TerminalTaskReview[];
  interruptRequestedAt?: string;
  error?: string;
}

export interface StartTerminalTaskRequest {
  expectedRevision: number;
  commandLine?: string;
}

export interface SendTerminalTaskRequest {
  expectedRevision: number;
  dispatchId: string;
  text: string;
  /** Running TUI input is queued; this does not promise strict turn/steer. */
  delivery: "when_idle" | "queue";
}

export interface ControlTerminalTaskRequest {
  expectedRevision: number;
  control: "supervisor" | "human";
  /** Caller has finished or cleared any unsent TUI draft. Not an automatic probe. */
  draftCleared?: boolean;
}

export interface ReviewTerminalTaskRequest extends Omit<TerminalTaskReview, "createdAt"> {
  expectedRevision: number;
}

export interface InterruptTerminalTaskRequest {
  expectedRevision: number;
  /** TUI Escape cannot atomically target a Codex turn. */
  scope: "terminal";
}

export interface TerminalTaskObservation {
  task: TerminalTask;
  terminalUrl: string | null;
  terminalState: TerminalState | null;
  availability: "available" | "starting" | "source_unavailable" | "target_changed" | "terminal_unavailable";
  readAt: string;
  /** Snapshot digest; can be used for bounded waiting, not as an event log cursor. */
  cursor: string;
  turns: AppServerThreadDetailTurn[];
  partial: boolean;
  error?: string;
}
