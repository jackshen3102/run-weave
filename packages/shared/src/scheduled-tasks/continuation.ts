export interface ScheduledContinuationPolicy {
  mode: "off" | "bounded";
}

/** A recommendation, never an authorization or proof of external success. */
export interface ScheduledRecovery {
  action: "continue" | "wait" | "needs-input" | "stop";
  category:
    | "remaining-work"
    | "transient"
    | "external-wait"
    | "input"
    | "permission"
    | "unknown";
  evidence: string;
  nextStep: string;
  notBefore: string | null;
  /** Concrete facts or action the user would confirm; absent for open questions. */
  confirmation?: string | null;
}

export interface ScheduledContinuation {
  count: number;
  maxAttempts: number;
  delaysMs: number[];
  windowMs: number;
  activeMs: number;
  deadline: string | null;
  nextAt: string | null;
  recovery: ScheduledRecovery | null;
  stopReason: string | null;
}

export interface ScheduledRunAttempt {
  id: string;
  runId: string;
  sequence: number;
  /** Actual user reply, never synthesized by automatic continuation. */
  userReply?: string;
  threadId: string | null;
  startedAt: string;
  finishedAt: string | null;
  outputStart: string;
  outputEnd: string | null;
  outcome: "succeeded" | "blocked" | "failed" | null;
  summary: string | null;
  error: { code: string; message: string } | null;
  recovery: ScheduledRecovery | null;
}
