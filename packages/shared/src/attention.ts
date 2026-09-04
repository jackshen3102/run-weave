export type AttentionState =
  | "needs_action"
  | "blocked"
  | "failed"
  | "completed"
  | "working";

export type AttentionTargetSurface = "terminal" | "agent-team";

export interface AttentionSlot {
  attentionId: string;
  projectId: string;
  parentProjectId: string;
  projectName: string;
  contextName: string;
  branch: string | null;
  terminalSessionId: string;
  sessionLabel: string;
  panelId: string | null;
  panelLabel: string | null;
  runId: string | null;
  state: AttentionState;
  title: string;
  detail: string;
  updatedAt: string;
  source: {
    kind: "terminal_session" | "agent_team_run";
    evidence: string;
  };
  targetSurface: AttentionTargetSurface;
  completionRevision: number | null;
}

export interface AttentionSnapshot {
  generatedAt: string;
  slots: AttentionSlot[];
}

export type CompanionPresentationLoadState =
  | "checking"
  | "ready"
  | "disconnected";

/**
 * The deliberately small state projection sent from the trusted Electron
 * renderer to the native macOS companion process. Authentication material and
 * backend URLs never cross the companion process boundary.
 */
export interface CompanionPresentationState {
  connectionId: string | null;
  state: CompanionPresentationLoadState;
  snapshot: AttentionSnapshot | null;
}

export interface AttentionOpenIntent {
  requestId: string;
  connectionId: string;
  attentionId: string;
  projectId: string;
  terminalSessionId: string;
  panelId: string | null;
  runId: string | null;
  targetSurface: AttentionTargetSurface;
  completionRevision: number | null;
}

export interface AttentionOpenDispatch extends AttentionOpenIntent {
  deadlineAt: number;
}

export type CompanionWindowDragRequest =
  | { phase: "start" | "move"; screenX: number; screenY: number }
  | { phase: "end" };

export type AttentionOpenResult =
  | { requestId: string; status: "opened" }
  | {
      requestId: string;
      status: "opened_with_panel_fallback";
      message: string;
    }
  | {
      requestId: string;
      status: "connection_unavailable" | "session_not_found" | "timed_out";
      message: string;
    };
