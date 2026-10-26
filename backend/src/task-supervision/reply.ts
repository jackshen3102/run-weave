import type {
  ConversationMessage,
  SupervisionConversationResponse,
} from "@runweave/shared/terminal/conversation";
import type { SupervisionInput, TaskWatch } from "@runweave/shared/task-supervision";
import type { ReplyEvent } from "./events";
import { digest, messagesFrom } from "./context";

export const isRuntimeErrorReply = (id: string) => id.startsWith("runtime-error:");

function runtimeErrorReply(
  source: SupervisionConversationResponse,
  event: ReplyEvent,
): SupervisionInput["currentReply"] | undefined {
  const error = source.runtimeError;
  if (!error || (event.turnId && event.turnId !== error.turnId)) return;
  // Retry only explicit transient provider failures, never auth/quota/permission failures.
  const transient = [
    "server_overloaded", "model_capacity_exceeded", "model_overloaded",
  ].includes(error.code) || (
    error.code === "agent_error" &&
    /selected model is at capacity|model.{0,40}(?:at capacity|overloaded)/i.test(error.message)
  );
  if (!error.turnId || !transient)
    throw new Error(`${error.code}: ${error.message}`);
  return {
    id: `runtime-error:${error.turnId}:${digest(`${error.code}:${error.message}`)}`,
    role: "runtime_error",
    text: `原生运行错误（非 Agent 最终回复）：${error.code}: ${error.message}`,
    rawTurnId: error.turnId,
    createdAt: event.createdAt,
  };
}

export function alreadyProcessedReply(
  watch: TaskWatch,
  threadId: string,
  reply: Pick<ConversationMessage, "id" | "rawTurnId">,
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
  const readError = () => runtimeErrorReply(source, event);
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
  const failure = readError();
  if (event.error && !failure)
    throw new Error(`${event.error.code}: ${event.error.message}`);
  let native: ConversationMessage | SupervisionInput["currentReply"] | undefined =
    failure ?? locate();
  for (let attempt = 0; !native && attempt < 3 && !signal.aborted; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    source = await read();
    messages = messagesFrom(source);
    native = readError() ?? locate();
  }
  if (!native)
    throw new Error("最终回复事件已收到，但完整会话尚不可读；等待下一条回复。");
  return { source, messages, native };
}
