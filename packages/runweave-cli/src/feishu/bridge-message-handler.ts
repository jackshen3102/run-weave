import type * as Lark from "@larksuiteoapi/node-sdk";
import type { TerminalHttpClient } from "../client/terminal-http-client.js";
import { HttpError } from "../errors.js";
import {
  DEFAULT_AGENT_START_TIMEOUT_MS,
  DEFAULT_CONFIRM_TIMEOUT_MS,
  sendWithConfirmation,
} from "../commands/terminal-agent.js";
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
    },
  ) {}

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

    let inputAttempted = false;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      TERMINAL_DELIVERY_TIMEOUT_MS,
    );
    try {
      const terminalClient = trackInputAttempt(
        this.params.terminalClient.withSignal(controller.signal),
        () => {
          inputAttempted = true;
        },
      );
      const result = await sendWithConfirmation({
        client: terminalClient,
        terminalSessionId: topic.terminalSessionId,
        text,
        enter: true,
        inputMode: "prompt_replace",
        inputModeProvided: true,
        panel: undefined,
        role: undefined,
        confirmMode: "short",
        confirmTimeoutMs: DEFAULT_CONFIRM_TIMEOUT_MS,
        agent: undefined,
        agentOverwrite: false,
        agentStartCommand: undefined,
        agentClearCommand: "/clear",
        agentExitCommand: undefined,
        agentStartTimeoutMs: DEFAULT_AGENT_START_TIMEOUT_MS,
      });
      if (result.inputAccepted !== true || result.inputEnqueued !== true) {
        throw new Error("Runweave did not accept terminal input");
      }
      await this.params.store.finishDelivery(
        event.message.message_id,
        "succeeded",
      );
      await this.addDoneReaction(event, topic);
    } catch (error) {
      const failure = classifyTerminalFailure(error, inputAttempted);
      await this.params.store.finishDelivery(
        event.message.message_id,
        failure.deliveryStatus,
      );
      this.log(failure.category, event, topic);
      await this.replyWithReceipt(
        event,
        topic,
        `投递失败：${failure.userText}`,
      );
      if (failure.removeTopic) {
        await this.params.store.clearTopic({
          chatId: topic.chatId,
          terminalSessionId: topic.terminalSessionId,
          expectedRootMessageId: topic.rootMessageId,
        });
      }
    } finally {
      clearTimeout(timeout);
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
      `Feishu topic delivery: category=${category} messageId=${event.message.message_id} terminalId=${topic.terminalSessionId} panelId=active\n`,
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

function trackInputAttempt(
  client: TerminalHttpClient,
  onInputAttempt: () => void,
): TerminalHttpClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "sendInput") {
        return (...args: Parameters<TerminalHttpClient["sendInput"]>) => {
          onInputAttempt();
          return target.sendInput(...args);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}
