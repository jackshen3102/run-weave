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
/** A bounded snapshot of an explicitly referenced deliverable, never execution authorization. */
export interface SupervisionDeliverable {
  id: string;
  kind: "local_document" | "github_pr";
  reference: string;
  sourceMessageId: string;
  readAt: string;
  availability: "available" | "missing" | "unavailable" | "too_large" | "outside_project";
  text?: string;
  digest?: string;
  version?: string;
}
export interface SupervisionDeliverables {
  items: SupervisionDeliverable[];
  omittedCount: number;
}
export interface SupervisionGoalContent {
  objective: string;
  completionCriteria: string;
  constraints: string;
}
export interface SupervisionGoalPlan {
  path: string;
  sourceMessageId: string;
  authorizationMessageId: string;
}
export interface SupervisionGoal extends SupervisionGoalContent {
  threadId: string;
  revisionId: string;
  version: number;
  origin: "conversation" | "manual";
  createdAt: string;
  sourceMessageIds: string[];
  plans: SupervisionGoalPlan[];
  /** Explicit user correction from the monitor, not a native conversation message. */
  manualInstruction?: ConversationMessage;
}
export interface SupervisionGoalDetail {
  goal: SupervisionGoal;
  messages: ConversationMessage[];
  plans: SupervisionPlan[];
  reason: string;
}
export interface SupervisionGoalPage {
  goals: Array<Pick<SupervisionGoalDetail, "goal" | "reason">>;
  nextCursor: string | null;
}
export interface SupervisionGoalPreview extends SupervisionGoalDetail {
  previewId: string;
  expectedRevision: number;
  target: SupervisionTarget;
  expiresAt: string;
  changed: boolean;
  needsClarification: boolean;
  requiresAdoption: boolean;
}
export interface PreviewSupervisionGoalRequest {
  expectedRevision: number;
  /** Omitted to regenerate from the conversation. */
  content?: SupervisionGoalContent;
}
export interface PreviousSupervisionContinuation {
  decisionId: string;
  reportMessageId: string;
  remainingWork: string;
  nextAction: string;
  authorizationMessageIds: string[];
  noProgressCount: number;
}
export type SupervisionCriterionState = "reported_done" | "pending" | "contradicted" | "unknown" | "waived";
export interface SupervisionAssessment {
  version: 1;
  disposition: "apply" | "hold";
  holdReason?: "evidence_gap" | "ambiguous_scores" | "no_progress";
  coverage: "complete" | "partial";
  criteria: Array<{ text: string; state: SupervisionCriterionState; sourceMessageIds: string[]; evidenceIds?: string[]; note: string }>;
  missingEvidence: string[];
  progress?: {
    previousDecisionId: string;
    state: "advanced" | "no_new_evidence" | "unknown";
    sourceMessageIds: string[];
    note: string;
    alternativePath: string;
  };
  thresholds: { minimumScore: number; minimumMargin: number };
}
export type SupervisionAssessmentSummary = Pick<SupervisionAssessment, "version" | "disposition" | "holdReason" | "coverage" | "thresholds"> & {
  counts: Record<SupervisionCriterionState, number>;
  note: string;
};
export interface SupervisionInput {
  task: ConversationMessage;
  goal: string;
  plan: SupervisionPlan[];
  userUpdates: ConversationMessage[];
  recentExchanges: ConversationMessage[];
  /** runtime_error projects a native failed turn, never an Agent completion report. */
  currentReply: Omit<ConversationMessage, "role"> & {
    role: ConversationMessage["role"] | "runtime_error";
    rawTurnId: string;
  };
  goalDefinition?: SupervisionGoal;
  previousContinuation?: PreviousSupervisionContinuation;
  /** Absent in historical inputs. Kept separate from adopted plans and user messages. */
  deliverables?: SupervisionDeliverables;
}
export interface SupervisionDecision {
  decisionId: string;
  threadId?: string;
  rawTurnId: string;
  replyDigest: string;
  contextRevision: number;
  goalVersion?: number;
  sourceVersion?: string;
  assessment?: SupervisionAssessment;
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
/** Current state and history pages never carry a model input snapshot. */
export type SupervisionDecisionSummary = Omit<SupervisionDecision, "input" | "assessment"> & {
  assessment?: SupervisionAssessmentSummary;
  currentReplyId: string;
  goalPreview: string;
};
export type SupervisionDecisionDetail = Omit<SupervisionDecisionSummary, "assessment"> & Pick<SupervisionDecision, "input" | "assessment">;
export interface SupervisionDecisionPage {
  decisions: SupervisionDecisionSummary[];
  nextCursor: string | null;
}
export function supervisionDecisionSummary(decision: SupervisionDecision): SupervisionDecisionSummary {
  const { input, assessment, ...summary } = decision;
  const counts: Record<SupervisionCriterionState, number> = { reported_done: 0, pending: 0, contradicted: 0, unknown: 0, waived: 0 };
  assessment?.criteria.forEach((criterion) => { counts[criterion.state]++; });
  return { ...summary, ...(assessment ? { assessment: {
    version: assessment.version, disposition: assessment.disposition, holdReason: assessment.holdReason,
    coverage: assessment.coverage, thresholds: assessment.thresholds, counts,
    note: (assessment.holdReason === "ambiguous_scores" ? "选项评分接近，暂不采用候选判断。" :
      assessment.missingEvidence[0] ?? assessment.progress?.note ?? (assessment.holdReason === "evidence_gap" ? "完成条件与候选结果不一致，当前资料不足。" : "逐项核对报告，不构成独立验收")).slice(0, 200),
  } } : {}), currentReplyId: input.currentReply.id, goalPreview: supervisionGoalPreview(input.goal) };
}
export interface TaskWatch {
  watchId: string;
  /** Persistent terminal switch; target is only the most recent reply's identity. */
  enabled: boolean;
  enabledAt: string;
  target: SupervisionTarget;
  taskStartMessageId: string;
  /** Identity of the native source; offsets must never be reused across replacements. */
  sourceVersion?: string;
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
  /** At most the latest decision in this thread. Full history has a separate paged API. */
  decisions: SupervisionDecisionSummary[];
  evidenceMessageIds?: string[];
  completedReplyIds?: string[];
  pendingReply?: {
    kind: "reply"; eventId: string; source: "terminal" | "app-server";
    terminalSessionId: string; panelId: string | null; threadId: string | null;
    summary: null; createdAt: string; turnId?: string | null;
  };
  goalOverride?: string;
  goalDefinition?: SupervisionGoal;
  goalState?: "checking" | "ready" | "needs_review";
  goalReason?: string;
  goalCheckedMessageId?: string;
  observedContinuationCount?: number;
  lastObservedContinuationId?: string;
  lastComparedContinuationId?: string;
  noProgressCount?: number;
}
export function currentSupervisionDecisions(watch: TaskWatch) {
  return watch.decisions.filter(
    (decision) =>
      decision.contextRevision === watch.contextRevision &&
      (!decision.threadId || decision.threadId === watch.target.threadId),
  );
}
export function supervisionDecisionLabel(decision: { outcome: TaskOutcome; assessment?: { disposition: "apply" | "hold" } }) {
  const label = { completed: "任务已完成", blocked: "需要你处理", continue: "任务可以继续" }[decision.outcome];
  if (decision.assessment?.disposition === "hold") return `判断待核对 · 候选：${label}（未采用）`;
  return decision.assessment && decision.outcome === "completed" ? "据报告完成" : label;
}
/** Display-only excerpt; classification and source views retain the complete goal. */
export function supervisionGoalPreview(goal: string) {
  const prose = goal.split(/\r?\n\s*(?:\{|```)/, 1)[0]!.trim();
  const preview = [...(prose || goal.trim())].slice(0, 240).join("");
  return preview.length < goal.trim().length ? `${preview}…` : preview;
}
export interface SupervisionDiscovery {
  /** Current Codex thread.name, never the user's prompt or monitoring goal. */
  threadTitle?: string | null;
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
  /** pause ends monitoring and deletes this terminal's supervision data. Start again with POST. */
  action: "pause" | "resume" | "update-context" | "retry-continuation";
  expectedRevision: number;
  goal?: string;
  decisionId?: string;
  expectedInputVersion?: string;
}
/** Closing a monitor returns null; the next start creates a new watchId. */
export type ChangeSupervisionResponse = TaskWatch | null;
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
