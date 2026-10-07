import type { ConversationMessage } from "@runweave/shared/terminal/conversation";
import type { ConversationContent } from "@runweave/shared/terminal/conversation";
import type { TaskWatch } from "@runweave/shared/task-supervision";

export function reconcileDelivery(
  watch: TaskWatch,
  messages: ConversationMessage[],
  now = Date.now(),
  threadId = watch.target.threadId,
) {
  let pendingCurrent = false;
  let timedOutCurrent = false;
  for (const decision of watch.decisions) {
    if (!["offered", "unknown"].includes(decision.delivery)) continue;
    if ((decision.threadId ?? watch.target.threadId) !== threadId) continue;
    const current = watch.target.threadId === threadId &&
      decision.contextRevision === watch.contextRevision;
    if (
      messages.some(
        (message) =>
          message.role === "user" &&
          message.text.includes(
            `[runweave-task-supervision:${decision.decisionId}]`,
          ),
      )
    ) {
      decision.delivery = "observed";
    } else {
      if (now > decision.deliveryDeadline) decision.delivery = "unknown";
      if (current) {
        pendingCurrent = true;
        timedOutCurrent ||= decision.delivery === "unknown";
      }
    }
  }
  // Historical offers remain auditable but cannot pause a new processing round.
  if (watch.enabled && watch.status === "watching" && timedOutCurrent) {
    watch.status = "paused";
    watch.pauseReason = "delivery_unknown";
    watch.revision++;
    watch.updatedAt = new Date(now).toISOString();
  } else if (watch.enabled && watch.target.threadId === threadId && watch.pauseReason === "delivery_unknown" && !pendingCurrent) {
    watch.status = "watching";
    delete watch.pauseReason;
    delete watch.error;
    watch.revision++;
    watch.updatedAt = new Date(now).toISOString();
  }
}

export async function readPendingDeliveries(
  watch: TaskWatch,
  read: (threadId: string) => Promise<ConversationContent>,
  update: (
    messages: ConversationMessage[],
    threadId: string,
  ) => Promise<unknown>,
) {
  const threads = new Set(
    watch.decisions
      .filter((d) => ["offered", "unknown"].includes(d.delivery))
      .map((d) => d.threadId ?? watch.target.threadId),
  );
  for (const threadId of threads) {
    if (!threadId) continue;
    const source = await read(threadId).catch(() => null);
    if (source?.availability === "available")
      await update(
        source.turns.flatMap((t) => t.messages),
        threadId,
      );
  }
}
