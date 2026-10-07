import { randomUUID } from "node:crypto";
import type {
  SupervisionTarget,
  TaskWatch,
} from "@runweave/shared/task-supervision";
import type { ConversationContent } from "@runweave/shared/terminal/conversation";
import { taskCandidates } from "./context";
import { updateWaitingState } from "./waiting";

export const sameTarget = (a: SupervisionTarget, b: SupervisionTarget) =>
  JSON.stringify(a) === JSON.stringify(b);

export function synchronizeTarget(
  watch: TaskWatch,
  target: SupervisionTarget,
  cancel?: () => void,
) {
  if (sameTarget(watch.target, target)) return;
  cancel?.();
  if (
    watch.target.threadId !== target.threadId ||
    watch.target.panelId !== target.panelId
  ) {
    const pendingId = `pending:${randomUUID()}`;
    watch.taskStartMessageId = pendingId;
    watch.task = { id: pendingId, role: "user", text: "" };
    watch.goal = "";
    watch.plans = [];
    watch.continuationCount = 0;
    watch.outcome = null;
    watch.contextRevision++;
    delete watch.lastFinalMessageId;
    delete watch.lastUserMessageId;
    delete watch.waitingFor;
    delete watch.error;
    if (watch.enabled) {
      watch.status = "watching";
      delete watch.pauseReason;
    }
  } else if (watch.status === "classifying") watch.status = "watching";
  watch.target = target;
  watch.revision++;
  watch.updatedAt = new Date().toISOString();
}
export function synchronizeContext(
  watch: TaskWatch,
  candidates: ReturnType<typeof taskCandidates>,
  cancel?: () => void,
) {
  const task = candidates[0];
  const latest = candidates.at(-1);
  if (!task || !latest) return;
  const pending = watch.taskStartMessageId.startsWith("pending:");
  if (
    pending ||
    !candidates.some((message) => message.id === watch.taskStartMessageId)
  ) {
    if (!pending) {
      // A complete source may now exclude an injected setup envelope selected by an older reader.
      cancel?.();
      watch.plans = [];
      watch.continuationCount = 0;
      watch.outcome = null;
      watch.contextRevision++;
      delete watch.lastFinalMessageId;
      delete watch.waitingFor;
      delete watch.error;
      if (watch.enabled) {
        watch.status = "watching";
        delete watch.pauseReason;
      }
    }
    watch.task = task;
    watch.taskStartMessageId = task.id;
    watch.goal = task.text;
    watch.lastUserMessageId = latest.id;
    watch.revision++;
    watch.updatedAt = new Date().toISOString();
    return;
  }
  // Older journals already contain the last observed user input in their decision snapshots.
  const previous = [...watch.decisions]
    .reverse()
    .find((decision) => decision.threadId === watch.target.threadId);
  const lastId =
    watch.lastUserMessageId ??
    previous?.input.userUpdates.at(-1)?.id ??
    watch.taskStartMessageId;
  if (lastId === latest.id) {
    watch.lastUserMessageId = latest.id;
    return;
  }
  cancel?.();
  watch.lastUserMessageId = latest.id;
  // Same-thread user input changes scope and renews the processing round, never the original task.
  updateWaitingState(watch, "userpromptsubmit", null);
  if (!watch.enabled) {
    watch.status = "paused";
    watch.pauseReason = "user_paused";
  }
}

export async function synchronizeWatch(
  target: SupervisionTarget,
  operations: {
    watch: () => TaskWatch;
    current: () => boolean;
    update: (change: (watch: TaskWatch) => void) => Promise<unknown>;
    cancel: () => void;
    read: (threadId: string) => Promise<ConversationContent>;
  },
) {
  if (!sameTarget(operations.watch().target, target))
    await operations.update((watch) => {
      if (operations.current())
        synchronizeTarget(watch, target, operations.cancel);
    });
  const candidates = target.threadId
    ? await operations
        .read(target.threadId)
        .then(taskCandidates)
        .catch(() => [])
    : [];
  const watch = operations.watch();
  if (
    candidates.length &&
    (watch.taskStartMessageId.startsWith("pending:") ||
      !candidates.some((message) => message.id === watch.taskStartMessageId) ||
      watch.lastUserMessageId !== candidates.at(-1)!.id)
  )
    await operations.update((watch) => {
      if (operations.current() && sameTarget(watch.target, target))
        synchronizeContext(watch, candidates, operations.cancel);
    });
  return candidates;
}
