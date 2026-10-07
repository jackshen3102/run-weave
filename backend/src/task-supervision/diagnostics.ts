import type { TaskWatch } from "@runweave/shared/task-supervision";
import { logger } from "../logging/index";
import type { ReplyEvent } from "./events";

export const supervisionLogger = logger.child({ component: "task-supervision" });

export function logInitialization(watches: TaskWatch[]) {
  supervisionLogger.info("task-supervision.initialized", {
    watchCount: watches.length,
    enabledWatchCount: watches.filter((watch) => watch.enabled).length,
    decisionCount: watches.reduce((count, watch) => count + watch.decisions.length, 0),
  });
}

export function watchFields(watch: TaskWatch) {
  return {
    watchId: watch.watchId,
    ...watch.target,
    revision: watch.revision,
    contextRevision: watch.contextRevision,
    enabled: watch.enabled,
    status: watch.status,
    outcome: watch.outcome,
    continuationCount: watch.continuationCount,
    pauseReason: watch.pauseReason ?? null,
    waitingFor: watch.waitingFor ?? null,
    taskStartMessageId: watch.taskStartMessageId,
    lastUserMessageId: watch.lastUserMessageId ?? null,
  };
}

export function replyFields(event: ReplyEvent) {
  return {
    eventId: event.eventId,
    eventSource: event.source,
    terminalSessionId: event.terminalSessionId,
    eventPanelId: event.panelId,
    eventThreadId: event.threadId,
    eventTurnId: event.turnId ?? null,
    eventCreatedAt: event.createdAt,
  };
}

/** Only committed state changes are facts; never copy conversation text into logs. */
export function logWatchChanges(before: TaskWatch[], after: TaskWatch[]) {
  for (const watch of after) {
    const previous = before.find((item) => item.watchId === watch.watchId);
    const fields = watchFields(watch);
    // Revision alone also changes during every classification; log meaningful transitions.
    const state = { ...fields, revision: 0 };
    const oldState = previous ? { ...watchFields(previous), revision: 0 } : null;
    if (JSON.stringify(state) !== JSON.stringify(oldState) || watch.error !== previous?.error)
      supervisionLogger.info("task-supervision.state.changed", {
        ...fields,
        previous: previous ? watchFields(previous) : null,
        ...(watch.error ? { error: new Error(watch.error) } : {}),
      });
    const oldDecisions = new Map(previous?.decisions.map((item) => [item.decisionId, item]));
    for (const decision of watch.decisions) {
      const old = oldDecisions.get(decision.decisionId);
      const identity = {
        ...fields,
        decisionId: decision.decisionId,
        threadId: decision.threadId,
        contextRevision: decision.contextRevision,
        rawTurnId: decision.rawTurnId,
      };
      if (!old)
        supervisionLogger.info("task-supervision.decision.recorded", {
          ...identity,
          replyMessageId: decision.input.currentReply.id,
          replyDigest: decision.replyDigest,
          outcome: decision.outcome,
          scores: decision.scores,
          model: decision.model,
          durationMs: decision.durationMs,
          sourceMessageIds: decision.sourceMessageIds,
          inputBytes: Buffer.byteLength(JSON.stringify(decision.input)),
          userUpdateCount: decision.input.userUpdates.length,
          recentExchangeCount: decision.input.recentExchanges.length,
          plans: decision.input.plan.map(({ digest, availability }) => ({ digest, availability: availability ?? null })),
          delivery: decision.delivery,
          deliveryReason: decision.outcome !== "continue"
            ? "outcome_does_not_request"
            : decision.delivery === "offered"
              ? "reserved"
              : watch.pauseReason === "continuation_limit"
                ? "continuation_limit"
                : "user_draft_pending",
          deliveryDeadline: decision.deliveryDeadline,
        });
      if (old && old.delivery !== decision.delivery)
        supervisionLogger.info("task-supervision.delivery.changed", {
          ...identity,
          previousDelivery: old.delivery,
          delivery: decision.delivery,
          deliveryDeadline: decision.deliveryDeadline,
        });
    }
  }
}
