import type { ConversationMessage } from "@runweave/shared/terminal/conversation";
import type { TaskWatch } from "@runweave/shared/task-supervision";

export function reconcileDelivery(
  watch: TaskWatch,
  messages: ConversationMessage[],
  now = Date.now(),
) {
  for (const decision of watch.decisions) {
    if (!["offered", "unknown"].includes(decision.delivery)) continue;
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
    } else if (now > decision.deliveryDeadline) {
      decision.delivery = "unknown";
      if (watch.status === "watching") {
        watch.status = "paused";
        watch.pauseReason = "delivery_unknown";
        watch.revision++;
        watch.updatedAt = new Date(now).toISOString();
      }
    }
  }
}
