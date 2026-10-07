import type { ConversationMessage } from "@runweave/shared/terminal/conversation";
import type { TaskWatch } from "@runweave/shared/task-supervision";

export function latestFinalId(messages: ConversationMessage[]) {
  return [...messages]
    .reverse()
    .find(
      (message) => message.role === "assistant" && message.phase === "final",
    )?.id;
}

/** Claim before classification so canceled and failed rounds cannot replay. */
export function claimFinal(
  watch: TaskWatch,
  messages: ConversationMessage[],
  reply: ConversationMessage,
) {
  const cursor =
    watch.lastFinalMessageId ?? watch.decisions.at(-1)?.input.currentReply.id;
  const current = messages.findIndex((message) => message.id === reply.id);
  const previous = cursor
    ? messages.findIndex((message) => message.id === cursor)
    : -1;
  if (reply.id === cursor || current <= previous) return false;
  watch.lastFinalMessageId = reply.id;
  return true;
}
