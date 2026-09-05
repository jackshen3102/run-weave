import { setTimeout as delay } from "node:timers/promises";
import type * as Lark from "@larksuiteoapi/node-sdk";
import type { TerminalHttpClient } from "../client/terminal-http-client.js";
import { HttpError } from "../errors.js";
import type { FeishuConfig } from "./config.js";
import type { FeishuStateStore, FeishuTopicActive } from "./state-store.js";

const MAX_INPUT_BYTES = 256 * 1024;
const TERMINAL_DELIVERY_TIMEOUT_MS = 15_000;

export interface FeishuInboundMessageEvent {
  sender: {
    sender_id?: { open_id?: string };
    sender_type: string;
  };
  message: {
    message_id: string;
    create_time?: string;
    parent_id?: string;
    root_id?: string;
    thread_id?: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{ key: string }>;
  };
}

export class FeishuBridgeMessageHandler {
  private readonly topicTails = new Map<string, Promise<void>>();

  constructor(
    private readonly params: {
      config: FeishuConfig;
      store: FeishuStateStore;
      client: Lark.Client;
      terminalClient: TerminalHttpClient;
      stderr: Pick<NodeJS.WriteStream, "write">;
      signal: AbortSignal;
    },
  ) {}

  async accept(event: FeishuInboundMessageEvent): Promise<void> {
    if (!this.isEligibleEnvelope(event) || this.params.signal.aborted) return;
    const topic = await this.params.store.findActiveTopicByRoot(
      event.message.chat_id,
      event.message.root_id!,
    );
    if (
      !topic ||
      (topic.threadId && topic.threadId !== event.message.thread_id)
    )
      return;
    const text = parseMessageText(
      event.message.content,
      event.message.mentions,
    );
    if (!text || Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
      if (
        (await this.params.store.beginDelivery(
          event.message.message_id,
          topic.terminalSessionId,
        )) === "started"
      ) {
        await this.params.store.finishDelivery(
          event.message.message_id,
          "failed",
        );
        await this.replyWithReceipt(
          event,
          topic,
          "投递失败：回复内容为空或过长",
        );
      }
      return;
    }
    if (!(await this.params.store.queueEvent(event, topic.terminalSessionId)))
      return;
    this.schedule(event);
  }

  async recover(): Promise<void> {
    for (const event of await this.params.store.waitingEvents())
      this.schedule(event);
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.topicTails.values());
  }

  private schedule(event: FeishuInboundMessageEvent): void {
    void this.enqueue(event).catch(() => {
      this.params.stderr.write(
        `${new Date().toISOString()} Feishu delivery: handler_failed messageId=${event.message.message_id}\n`,
      );
    });
  }

  enqueue(event: FeishuInboundMessageEvent): Promise<void> {
    if (!this.isEligibleEnvelope(event)) return Promise.resolve();
    const key = JSON.stringify([event.message.chat_id, event.message.root_id]);
    const previous = this.topicTails.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => await this.handle(event));
    this.topicTails.set(key, current);
    void current
      .finally(() => {
        if (this.topicTails.get(key) === current) this.topicTails.delete(key);
      })
      .catch(() => undefined);
    return current;
  }

  private isEligibleEnvelope(event: FeishuInboundMessageEvent): boolean {
    const openId = event.sender.sender_id?.open_id;
    return Boolean(
      event.sender.sender_type === "user" &&
      openId &&
      this.params.config.allowedOpenIds.has(openId) &&
      event.message.chat_type === "group" &&
      event.message.chat_id === this.params.config.targetChatId &&
      event.message.message_type === "text" &&
      event.message.root_id &&
      event.message.thread_id,
    );
  }

  private async handle(event: FeishuInboundMessageEvent): Promise<void> {
    const rootMessageId = event.message.root_id;
    if (!rootMessageId) return;
    const topic = await this.params.store.findActiveTopicByRoot(
      event.message.chat_id,
      rootMessageId,
    );
    if (!topic) return;
    if (topic.threadId && topic.threadId !== event.message.thread_id) return;

    const deliveryState = await this.params.store.beginDelivery(
      event.message.message_id,
      topic.terminalSessionId,
    );
    if (deliveryState !== "started") return;

    const text = parseMessageText(
      event.message.content,
      event.message.mentions,
    );
    if (!text || Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
      await this.params.store.finishDelivery(
        event.message.message_id,
        "failed",
      );
      await this.replyWithReceipt(event, topic, "投递失败：回复内容为空或过长");
      return;
    }

    const entry = await this.params.store.delivery(event.message.message_id);
    const deadline = Date.parse(entry?.expiresAt ?? new Date().toISOString());
    let inputAttempted = false;
    let lastError: unknown = new Error("Delivery expired before sending");
    let waitingLogged = false;
    while (!this.params.signal.aborted && Date.now() < deadline) {
      const signal = AbortSignal.any([
        this.params.signal,
        AbortSignal.timeout(
          Math.max(
            1,
            Math.min(TERMINAL_DELIVERY_TIMEOUT_MS, deadline - Date.now()),
          ),
        ),
      ]);
      try {
        const client = this.params.terminalClient.withSignal(signal);
        // Read-only preflight can be retried across backend downtime.
        await client.getSession(topic.terminalSessionId);
        signal.throwIfAborted();
        await this.params.store.markInputAttempt(
          event.message.message_id,
          true,
        );
        if (this.params.signal.aborted || Date.now() >= deadline) {
          await this.params.store.markInputAttempt(
            event.message.message_id,
            false,
          );
          if (this.params.signal.aborted) break;
          throw new Error("delivery_expired");
        }
        inputAttempted = true;
        const result = await client.sendInput(topic.terminalSessionId, {
          operationId: `feishu:${event.message.message_id}`,
          data: text,
          mode: "prompt_replace",
          submit: true,
        });
        if (result.inputAccepted !== true || result.inputEnqueued !== true) {
          throw new Error("Runweave did not accept terminal input");
        }
        await this.params.store.finishDelivery(
          event.message.message_id,
          "succeeded",
        );
        this.log("succeeded", event, topic);
        await this.addDoneReaction(event, topic);
        return;
      } catch (error) {
        lastError = error;
        // A 401 is an explicit rejection before input execution, safe to retry.
        if (error instanceof HttpError && error.status === 401) {
          await this.params.store.markInputAttempt(
            event.message.message_id,
            false,
          );
          inputAttempted = false;
        }
        const retryable =
          !inputAttempted &&
          (!(error instanceof HttpError) ||
            error.status === 401 ||
            error.status === 429 ||
            error.status >= 500);
        if (!retryable || this.params.signal.aborted) break;
        if (!waitingLogged) {
          this.log("waiting_for_backend", event, topic);
          waitingLogged = true;
        }
        await delay(
          Math.min(2_000, Math.max(1, deadline - Date.now())),
          undefined,
          { signal: this.params.signal },
        ).catch(() => undefined);
      }
    }
    if (this.params.signal.aborted && !inputAttempted) {
      await this.params.store.finishDelivery(
        event.message.message_id,
        "waiting",
      );
      return;
    }
    if (!inputAttempted && Date.now() >= deadline)
      lastError = new Error("delivery_expired");
    const failure = classifyTerminalFailure(lastError, inputAttempted);
    await this.params.store.finishDelivery(
      event.message.message_id,
      failure.deliveryStatus,
    );
    this.log(failure.category, event, topic);
    await this.replyWithReceipt(
      event,
      topic,
      inputAttempted && failure.deliveryStatus === "unknown"
        ? "投递结果未知：请先检查终端，未自动重发"
        : `投递失败：${failure.userText}，请在恢复后重新发送`,
    );
    if (failure.removeTopic) {
      await this.params.store.clearTopic({
        chatId: topic.chatId,
        terminalSessionId: topic.terminalSessionId,
        expectedRootMessageId: topic.rootMessageId,
      });
    }
  }

  private async addDoneReaction(
    event: FeishuInboundMessageEvent,
    topic: FeishuTopicActive,
  ): Promise<void> {
    try {
      const response = await this.params.client.im.v1.messageReaction.create({
        path: { message_id: event.message.message_id },
        data: { reaction_type: { emoji_type: "DONE" } },
      });
      if (response.code) throw new Error("reaction response failed");
    } catch {
      this.log("reaction_failed", event, topic);
    }
  }

  private async replyWithReceipt(
    event: FeishuInboundMessageEvent,
    topic: FeishuTopicActive,
    text: string,
  ): Promise<void> {
    try {
      const response = await this.params.client.im.v1.message.reply({
        path: { message_id: event.message.message_id },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text }),
          reply_in_thread: true,
        },
      });
      if (response.code || !response.data?.message_id) {
        throw new Error("receipt response failed");
      }
    } catch {
      this.log("receipt_failed", event, topic);
    }
  }

  private log(
    category: string,
    event: FeishuInboundMessageEvent,
    topic: FeishuTopicActive,
  ): void {
    this.params.stderr.write(
      `${new Date().toISOString()} Feishu topic delivery: category=${category} messageId=${event.message.message_id} terminalId=${topic.terminalSessionId} panelId=active\n`,
    );
  }
}

export function stripFeishuMentions(
  text: string,
  mentions: Array<{ key: string }> | undefined,
): string {
  let normalized = text;
  for (const mention of mentions ?? []) {
    if (mention.key) normalized = normalized.replaceAll(mention.key, "");
  }
  return normalized.trim();
}

function parseMessageText(
  content: string,
  mentions: Array<{ key: string }> | undefined,
): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === "string"
      ? stripFeishuMentions(parsed.text, mentions)
      : "";
  } catch {
    return "";
  }
}

function classifyTerminalFailure(
  error: unknown,
  inputAttempted: boolean,
): {
  category: string;
  userText: string;
  removeTopic: boolean;
  deliveryStatus: "failed" | "unknown";
} {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("delivery_expired")) {
    return {
      category: "waiting_expired",
      userText: "等待恢复超过 120 秒，尚未发送",
      removeTopic: false,
      deliveryStatus: "failed",
    };
  }
  if (isAbortError(error)) {
    return inputAttempted
      ? {
          category: "backend_timeout_unknown",
          userText: "Runweave 响应超时，投递结果未知",
          removeTopic: false,
          deliveryStatus: "unknown",
        }
      : {
          category: "backend_timeout",
          userText: "Runweave 后端响应超时",
          removeTopic: false,
          deliveryStatus: "failed",
        };
  }
  if (error instanceof HttpError && error.status === 401) {
    return {
      category: "backend_unauthorized",
      userText: "Runweave 认证失败",
      removeTopic: false,
      deliveryStatus: "failed",
    };
  }
  if (error instanceof HttpError && error.status === 404) {
    return {
      category: "terminal_missing",
      userText: "Terminal 不存在",
      removeTopic: true,
      deliveryStatus: "failed",
    };
  }
  if (inputAttempted) {
    return {
      category: "input_result_unknown",
      userText: "终端投递结果未知",
      removeTopic: false,
      deliveryStatus: "unknown",
    };
  }
  if (message.includes("not running") || message.includes("exited")) {
    return {
      category: "terminal_not_running",
      userText: "Terminal 不可运行",
      removeTopic: false,
      deliveryStatus: "failed",
    };
  }
  if (
    message.includes("fetch") ||
    message.includes("connect") ||
    message.includes("econnrefused")
  ) {
    return {
      category: "backend_unreachable",
      userText: "Runweave 后端不可达",
      removeTopic: false,
      deliveryStatus: "failed",
    };
  }
  return {
    category: "input_rejected",
    userText: "Runweave 未接受输入",
    removeTopic: false,
    deliveryStatus: "failed",
  };
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}
