import type { ConversationMessage } from "./terminal/conversation.js";

export type TaskOutcome = "completed" | "blocked" | "continue";
export type WatchStatus =
  | "watching"
  | "classifying"
  | "paused"
  | "error"
  | "ended";
export interface SupervisionTarget {
  terminalSessionId: string;
  panelId: string;
  threadId: string;
  executorGeneration: string;
}
export interface SupervisionPlan {
  path: string;
  digest: string;
  text: string;
  /** Absent in older journals. Snapshot content is historical; missing has no readable content. */
  availability?: "current" | "snapshot" | "missing";
}
export interface SupervisionInput {
  task: ConversationMessage;
  goal: string;
  plan: SupervisionPlan[];
  userUpdates: ConversationMessage[];
  recentExchanges: ConversationMessage[];
  currentReply: ConversationMessage & { rawTurnId: string };
}
export interface SupervisionDecision {
  decisionId: string;
  threadId?: string;
  rawTurnId: string;
  replyDigest: string;
  contextRevision: number;
  model: string;
  codexVersion?: string;
  durationMs: number;
  scores: Record<TaskOutcome, number>;
  outcome: TaskOutcome;
  reason: string;
  /** Absent in historical decisions; never infer authorization from a model score. */
  guidance?: {
    remainingWork: string;
    nextAction: string;
    authorizationMessageIds: string[];
    blocker: string;
    requiredUserAction: string;
  };
  policyVersion?: string;
  sourceMessageIds: string[];
  createdAt: string;
  input: SupervisionInput;
  delivery: "not_requested" | "offered" | "observed" | "unknown";
  deliveryDeadline: number;
  /** Classification succeeded, but no continuation was offered because the editor state is unknown. */
  deliveryBlock?: "draft_unconfirmed" | "not_sent";
}
export interface TaskWatch {
  watchId: string;
  /** Persistent terminal switch; target is only the most recent reply's identity. */
  enabled: boolean;
  enabledAt: string;
  target: SupervisionTarget;
  taskStartMessageId: string;
  task: ConversationMessage;
  goal: string;
  plans: SupervisionPlan[];
  revision: number;
  contextRevision: number;
  status: WatchStatus;
  outcome: TaskOutcome | null;
  continuationLimit: 3;
  continuationCount: number;
  pauseReason?:
    | "user_paused"
    | "interrupted"
    | "continuation_limit"
    | "delivery_unknown"
    | "target_changed"
    | "replaced";
  error?: string;
  waitingFor?: "permission" | "question";
  lastFinalMessageId?: string;
  /** Last ordinary user message observed; supervision prompts never advance it. */
  lastUserMessageId?: string;
  createdAt: string;
  updatedAt: string;
  decisions: SupervisionDecision[];
}
export function currentSupervisionDecisions(watch: TaskWatch) {
  return watch.decisions.filter(
    (decision) =>
      decision.contextRevision === watch.contextRevision &&
      (!decision.threadId || decision.threadId === watch.target.threadId),
  );
}
/** Display-only excerpt; classification and source views retain the complete goal. */
export function supervisionGoalPreview(goal: string) {
  const prose = goal.split(/\r?\n\s*(?:\{|```)/, 1)[0]!.trim();
  const preview = [...(prose || goal.trim())].slice(0, 240).join("");
  return preview.length < goal.trim().length ? `${preview}…` : preview;
}
export interface SupervisionDiscovery {
  /** Opaque live input fence for explicit draft confirmation. Never persisted across restarts. */
  inputVersion?: string;
  target: SupervisionTarget | null;
  watch: TaskWatch | null;
  capability: {
    supported: boolean;
    reason?: string;
    codexVersion?: string;
    hookVersion?: number;
  };
  taskCandidates: ConversationMessage[];
}
export interface StartSupervisionRequest {
  target: SupervisionTarget;
  taskStartMessageId: string;
  goal: string;
  planPaths: string[];
  requestId: string;
  replacesWatchId?: string;
  expectedRevision?: number;
}
export interface ChangeSupervisionRequest {
  action: "pause" | "resume" | "update-context" | "retry-continuation";
  expectedRevision: number;
  goal?: string;
  decisionId?: string;
  expectedInputVersion?: string;
}
export interface SupervisionHookRequest {
  target: SupervisionTarget;
  event:
    | "SessionStart"
    | "UserPromptSubmit"
    | "Interrupt"
    | "Stop"
    | "PermissionRequest"
    | "PreToolUse"
    | "PostToolUse";
  toolName?: string;
  hookVersion: 1;
  codexVersion: string;
  executionModel?: string;
  executionConfig?: {
    binary: string;
    home: string;
    cwd: string;
    args: string[];
  };
  rawTurnId?: string;
  reply?: string;
  prompt?: string;
  deadline: number;
}
export type SupervisionHookResponse =
  | { action: "allow-stop" }
  | {
      action: "request-continuation";
      reason: string;
      watchId: string;
      decisionId: string;
      revision: number;
      deadline: number;
    };
