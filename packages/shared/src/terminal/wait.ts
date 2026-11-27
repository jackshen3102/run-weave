import type { AttentionActionKind, AttentionState } from "../attention";
import type { TerminalPanelRole } from "./panel";
import type { TerminalInputMode } from "./runtime/input";
import type { TerminalSessionHistoryResponse } from "./runtime/session";
import type { TerminalState } from "./runtime/state";

export type TerminalWaitTargetState = "idle" | "blocked";

export interface TerminalSendAndWaitRequest {
  operationId: string;
  data: string;
  panelId?: string;
  panelAlias?: string;
  role?: TerminalPanelRole;
  mode?: TerminalInputMode;
  submit?: boolean;
  wait: {
    until?: TerminalWaitTargetState[];
    timeoutMs?: number;
    activityGateMs?: number;
    rejectIfBlocked?: boolean;
  };
}

export type TerminalWaitOutcome =
  | "settled"
  | "stalled"
  | "timeout"
  | "session_exited";

export type TerminalWaitErrorCode =
  | "AGENT_BLOCKED"
  | "AGENT_PROMPT_STALLED"
  | "WAIT_TIMEOUT"
  | "SESSION_EXITED"
  | "TOO_MANY_WAIT_REQUESTS"
  | "INVALID_REGEX";

export interface TerminalSendAndWaitResponse {
  operationId: string;
  terminalSessionId: string;
  panelId: string | null;
  inputAccepted: boolean;
  outcome: TerminalWaitOutcome;
  code?: TerminalWaitErrorCode;
  matchedState: TerminalWaitTargetState | null;
  terminalState: TerminalState;
  attentionState: AttentionState | null;
  attentionActionKind?: AttentionActionKind;
  elapsedMs: number;
  note?: string;
}

export interface TerminalWaitOutputRequest {
  panelId?: string;
  panelAlias?: string;
  role?: TerminalPanelRole;
  match?: string;
  regex?: string;
  lines?: number;
  unwrap?: boolean;
  timeoutMs?: number;
}

export interface TerminalWaitOutputResponse {
  terminalSessionId: string;
  panelId: string | null;
  matched: boolean;
  matchedLine: string | null;
  snapshot: string;
  elapsedMs: number;
}

export interface TerminalSnapshotResponse
  extends TerminalSessionHistoryResponse {
  panelId: string | null;
  unwrapped: boolean;
}
