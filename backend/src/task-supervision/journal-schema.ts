import { z } from "zod";
const id = z.string().min(1);
const message = z.object({
  id,
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: z.string().optional(),
  rawTurnId: id.optional(),
  phase: z.enum(["commentary", "final"]).optional(),
});
const plan = z.object({
  path: id,
  digest: id,
  text: z.string(),
  availability: z.enum(["current", "snapshot", "missing"]).optional(),
});
const outcome = z.enum(["completed", "blocked", "continue"]);
const scores = z
  .object({
    completed: z.number().min(0).max(1),
    blocked: z.number().min(0).max(1),
    continue: z.number().min(0).max(1),
  })
  .refine((s) => Math.abs(s.completed + s.blocked + s.continue - 1) < 0.000001);
const input = z.object({
  task: message,
  goal: id,
  plan: z.array(plan),
  userUpdates: z.array(message),
  recentExchanges: z.array(message),
  currentReply: message.extend({ rawTurnId: id }),
});
const decision = z.object({
  decisionId: z.string().uuid(),
  threadId: id.optional(),
  rawTurnId: id,
  replyDigest: id,
  contextRevision: z.number().int().positive(),
  model: id,
  codexVersion: id.optional(),
  durationMs: z.number().nonnegative(),
  scores,
  outcome,
  reason: id,
  guidance: z.object({
    remainingWork: z.string(),
    nextAction: z.string(),
    authorizationMessageIds: z.array(id),
    blocker: z.string(),
    requiredUserAction: z.string(),
  }).optional(),
  policyVersion: id.optional(),
  sourceMessageIds: z.array(id).min(1),
  createdAt: id,
  input,
  delivery: z.enum(["not_requested", "offered", "observed", "unknown"]),
  deliveryDeadline: z.number().int().positive(),
  deliveryBlock: z.enum(["draft_unconfirmed", "not_sent"]).optional(),
});
export const journalSchema = z.object({
  version: z.literal(1),
  watches: z.array(
    z
      .object({
        watchId: z.string().uuid(),
        enabled: z.boolean().optional(),
        enabledAt: z.string().optional(),
        target: z.object({
          terminalSessionId: id,
          panelId: id,
          threadId: z.string(),
          executorGeneration: id,
        }),
        taskStartMessageId: id,
        task: message,
        goal: z.string(),
        plans: z.array(plan),
        revision: z.number().int().positive(),
        contextRevision: z.number().int().positive(),
        status: z.enum(["watching", "classifying", "paused", "error", "ended"]),
        outcome: outcome.nullable(),
        continuationLimit: z.literal(3),
        continuationCount: z.number().int().min(0).max(3),
        pauseReason: z
          .enum([
            "user_paused",
            "interrupted",
            "continuation_limit",
            "delivery_unknown",
            "target_changed",
            "replaced",
          ])
          .optional(),
        error: z.string().optional(),
        waitingFor: z.enum(["permission", "question"]).optional(),
        lastFinalMessageId: id.optional(),
        lastUserMessageId: id.optional(),
        createdAt: id,
        updatedAt: id,
        decisions: z.array(decision),
      })
      .transform((watch) => ({
        ...watch,
        error: watch.error === "终端有用户输入尚未提交；保留草稿，等待下一轮回复。"
          ? "无法确认原终端输入框是否为空，自动续接未发送。请检查原终端；确认没有草稿后可重试。" : watch.error,
        enabled:
          watch.enabled ??
          ["watching", "classifying", "error"].includes(watch.status),
        enabledAt: watch.enabledAt ?? watch.createdAt,
        decisions: watch.decisions.map((decision) => ({
          ...decision,
          deliveryBlock: decision.deliveryBlock ?? (
            watch.status === "error" && watch.error === "终端有用户输入尚未提交；保留草稿，等待下一轮回复。" &&
            decision === watch.decisions.at(-1) && decision.contextRevision === watch.contextRevision &&
            (!decision.threadId || decision.threadId === watch.target.threadId) &&
            decision.outcome === "continue" && decision.delivery === "not_requested"
              ? "draft_unconfirmed" as const : undefined),
          threadId: decision.threadId ?? watch.target.threadId,
        })),
      })),
  ),
  requests: z.record(z.object({ digest: id, watchId: z.string().uuid() })),
});
