import { randomUUID } from "node:crypto";
import type * as Lark from "@larksuiteoapi/node-sdk";
import type {
  FeishuStateStore,
  FeishuTopicActive,
  FeishuTopicCreating,
} from "./state-store.js";

const TOPIC_WAIT_TIMEOUT_MS = 35_000;
const TOPIC_POLL_INTERVAL_MS = 100;
const TOPIC_CREATE_RETRY_INTERVAL_MS = 250;
const TOPIC_CREATE_MAX_ATTEMPTS = 2;
const FEISHU_MESSAGE_DELETED_CODE = 230110;

export interface TopicNotificationResult {
  rootMessageId: string;
  messageId: string;
  createdTopic: boolean;
}

export async function notifyFeishuTopic(params: {
  client: Lark.Client;
  store: FeishuStateStore;
  chatId: string;
  terminalSessionId: string;
  notificationText: string;
}): Promise<TopicNotificationResult> {
  const requestId = randomUUID();
  const deadline = Date.now() + TOPIC_WAIT_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    const claim = await params.store.claimTopicCreation({
      chatId: params.chatId,
      terminalSessionId: params.terminalSessionId,
      requestId,
    });
    if (claim.kind === "active") {
      const reply = await replyToTopic({
        ...params,
        topic: claim.topic,
        requestId,
      });
      if (reply) return reply;
      continue;
    }
    if (claim.kind === "waiting") {
      await wait(TOPIC_POLL_INTERVAL_MS);
      continue;
    }
    return await createTopic({
      ...params,
      claim: claim.topic,
      requestId,
      deadline,
    });
  }

  throw new Error("Timed out waiting for Feishu topic creation");
}

async function createTopic(params: {
  client: Lark.Client;
  store: FeishuStateStore;
  chatId: string;
  terminalSessionId: string;
  notificationText: string;
  requestId: string;
  claim: FeishuTopicCreating;
  deadline: number;
}): Promise<TopicNotificationResult> {
  let response: Awaited<
    ReturnType<Lark.Client["im"]["v1"]["message"]["create"]>
  >;
  for (let attempt = 1; ; attempt += 1) {
    try {
      response = await params.client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: params.chatId,
          msg_type: "text",
          content: JSON.stringify({ text: params.notificationText }),
          uuid: params.claim.creationUuid,
        },
      });
      assertMessageResponse(response, "create topic root", {
        chatId: params.chatId,
      });
      break;
    } catch (error) {
      if (!isAmbiguousCreateError(error)) {
        await params.store.releaseTopicCreation({
          chatId: params.chatId,
          terminalSessionId: params.terminalSessionId,
          ownerToken: params.claim.ownerToken,
        });
        throw error;
      }
      if (
        attempt >= TOPIC_CREATE_MAX_ATTEMPTS ||
        Date.now() + TOPIC_CREATE_RETRY_INTERVAL_MS > params.deadline
      ) {
        throw error;
      }
      await wait(TOPIC_CREATE_RETRY_INTERVAL_MS);
    }
  }

  const rootMessageId = response.data?.message_id;
  if (!rootMessageId) {
    throw new Error("Feishu create topic root failed: missing_message_id");
  }
  let topic = await params.store.activateTopic({
    chatId: params.chatId,
    terminalSessionId: params.terminalSessionId,
    ownerToken: params.claim.ownerToken,
    rootMessageId,
    threadId: response.data?.thread_id ?? null,
  });
  topic ??= await params.store.getActiveTopic(
    params.chatId,
    params.terminalSessionId,
  );
  if (!topic) {
    throw new Error("Feishu topic activation lost its creation claim");
  }

  if (params.requestId !== params.claim.firstRequestId) {
    const reply = await replyToActiveTopic({
      ...params,
      topic,
      requestId: params.requestId,
    });
    return { ...reply, createdTopic: true };
  }

  return {
    rootMessageId: topic.rootMessageId,
    messageId: topic.rootMessageId,
    createdTopic: true,
  };
}

async function replyToTopic(params: {
  client: Lark.Client;
  store: FeishuStateStore;
  chatId: string;
  terminalSessionId: string;
  notificationText: string;
  requestId: string;
  topic: FeishuTopicActive;
}): Promise<TopicNotificationResult | null> {
  if (await isTopicRootDeleted(params.client, params.topic.rootMessageId)) {
    return await clearDeletedTopic(params);
  }
  try {
    return await replyToActiveTopic(params);
  } catch (replyError) {
    const rootDeleted = await isTopicRootDeleted(
      params.client,
      params.topic.rootMessageId,
    );
    if (!rootDeleted) throw replyError;
    return await clearDeletedTopic(params);
  }
}

async function clearDeletedTopic(params: {
  client: Lark.Client;
  store: FeishuStateStore;
  chatId: string;
  terminalSessionId: string;
  notificationText: string;
  requestId: string;
  topic: FeishuTopicActive;
}): Promise<TopicNotificationResult | null> {
  const cleared = await params.store.clearTopic({
    chatId: params.chatId,
    terminalSessionId: params.terminalSessionId,
    expectedRootMessageId: params.topic.rootMessageId,
  });
  if (!cleared) {
    const current = await params.store.getActiveTopic(
      params.chatId,
      params.terminalSessionId,
    );
    if (current) {
      return await replyToActiveTopic({ ...params, topic: current });
    }
  }
  return null;
}

async function replyToActiveTopic(params: {
  client: Lark.Client;
  store: FeishuStateStore;
  chatId: string;
  terminalSessionId: string;
  notificationText: string;
  requestId: string;
  topic: FeishuTopicActive;
}): Promise<TopicNotificationResult> {
  const response = await params.client.im.v1.message.reply({
    path: { message_id: params.topic.rootMessageId },
    data: {
      msg_type: "text",
      content: JSON.stringify({ text: params.notificationText }),
      reply_in_thread: true,
      uuid: params.requestId,
    },
  });
  assertMessageResponse(response, "reply to topic root", {
    chatId: params.chatId,
    rootMessageId: params.topic.rootMessageId,
  });
  const messageId = response.data?.message_id;
  if (!messageId) {
    throw new Error("Feishu reply to topic root failed: missing_message_id");
  }
  const threadId = response.data?.thread_id;
  if (
    threadId &&
    !(await params.store.recordTopicThread({
      chatId: params.chatId,
      terminalSessionId: params.terminalSessionId,
      rootMessageId: params.topic.rootMessageId,
      threadId,
    }))
  ) {
    throw new Error("Feishu topic changed before thread ID was saved");
  }
  return {
    rootMessageId: params.topic.rootMessageId,
    messageId,
    createdTopic: false,
  };
}

async function isTopicRootDeleted(
  client: Lark.Client,
  rootMessageId: string,
): Promise<boolean> {
  try {
    const response = await client.im.v1.message.get({
      path: { message_id: rootMessageId },
    });
    if (response.code === FEISHU_MESSAGE_DELETED_CODE) return true;
    if (response.code) return false;
    const root = response.data?.items?.find(
      (item) => item.message_id === rootMessageId,
    );
    return !root || root.deleted === true;
  } catch (error) {
    return getFeishuErrorCode(error) === FEISHU_MESSAGE_DELETED_CODE;
  }
}

function getFeishuErrorCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    code?: unknown;
    response?: { data?: { code?: unknown } };
  };
  const code = candidate.response?.data?.code ?? candidate.code;
  return typeof code === "number" ? code : null;
}

function assertMessageResponse(
  response: {
    code?: number;
    data?: {
      message_id?: string;
      chat_id?: string;
      root_id?: string;
    };
  },
  action: string,
  expected: { chatId: string; rootMessageId?: string },
): void {
  if (response.code || !response.data?.message_id) {
    throw new Error(
      `Feishu ${action} failed: ${response.code ?? "missing_message_id"}`,
    );
  }
  if (response.data.chat_id && response.data.chat_id !== expected.chatId) {
    throw new Error(`Feishu ${action} failed: chat_mismatch`);
  }
  if (
    expected.rootMessageId &&
    response.data.root_id &&
    response.data.root_id !== expected.rootMessageId
  ) {
    throw new Error(`Feishu ${action} failed: root_mismatch`);
  }
}

function isAmbiguousCreateError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const status = candidate.response?.status ?? candidate.status;
  const message =
    typeof candidate.message === "string"
      ? candidate.message.toLowerCase()
      : "";
  return (
    (typeof status === "number" && status >= 500 && status <= 599) ||
    candidate.name === "AbortError" ||
    [
      "ABORT_ERR",
      "ECONNABORTED",
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ETIMEDOUT",
      "ENETDOWN",
      "ENETUNREACH",
      "EHOSTUNREACH",
    ].includes(code) ||
    message.includes("timeout") ||
    message.includes("socket hang up") ||
    message.includes("fetch failed") ||
    message.includes("network error")
  );
}

async function wait(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
