import type {
  ConversationMessage,
  SupervisionConversationResponse,
} from "@runweave/shared/terminal/conversation";
import type { TaskWatch } from "@runweave/shared/task-supervision";
import type { ReplyEvent } from "./events";
import { messagesFrom } from "./context";

export function alreadyProcessedReply(
  watch: TaskWatch,
  threadId: string,
  reply: ConversationMessage,
) {
  return (
    watch.lastFinalMessageId === `${threadId}:${reply.id}` ||
    watch.decisions.some(
      (decision) =>
        decision.threadId === threadId &&
        decision.contextRevision === watch.contextRevision &&
        decision.goalVersion === watch.goalDefinition?.version &&
        decision.currentReplyId === reply.id &&
        decision.rawTurnId === (reply.rawTurnId ?? reply.id),
    )
  );
}

export async function readFinalReply(
  read: () => Promise<SupervisionConversationResponse>,
  event: ReplyEvent,
  signal: AbortSignal,
) {
  let source = await read();
  const runtimeError = source.runtimeError;
  if (runtimeError && (!event.turnId || event.turnId === runtimeError.turnId)) throw new Error(`${runtimeError.code}: ${runtimeError.message}`);
  let messages = messagesFrom(source);
  const locate = () =>
    [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" &&
          message.phase !== "commentary" &&
          (!event.turnId || message.rawTurnId === event.turnId) &&
          (!event.summary ||
            message.text === event.summary ||
            message.text.startsWith(
              event.summary.replace(/\n\.\.\.\[truncated\]$/, ""),
            )),
      );
  let native = locate();
  for (let attempt = 0; !native && attempt < 3 && !signal.aborted; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    source = await read();
    messages = messagesFrom(source);
    native = locate();
  }
  if (!native)
    throw new Error("最终回复事件已收到，但完整会话尚不可读；等待下一条回复。");
  return { source, messages, native };
}
