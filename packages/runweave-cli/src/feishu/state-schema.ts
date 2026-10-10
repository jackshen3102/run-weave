import type { FeishuInboundMessageEvent } from "./bridge-message-handler.js";
export type DeliveryStatus =
  | "waiting"
  | "processing"
  | "succeeded"
  | "failed"
  | "unknown";

export interface ProcessedMessage {
  messageId: string;
  status: DeliveryStatus;
  terminalSessionId: string;
  backendId?: string;
  updatedAt: string;
  event?: FeishuInboundMessageEvent;
  expiresAt?: string;
  inputAttempted?: boolean;
}

export interface FeishuTopicCreating {
  status: "creating";
  chatId: string;
  terminalSessionId: string;
  backendId?: string;
  creationUuid: string;
  firstRequestId: string;
  ownerToken: string;
  leaseExpiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeishuTopicActive {
  status: "active";
  chatId: string;
  terminalSessionId: string;
  backendId?: string;
  rootMessageId: string;
  threadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FeishuTopicRecord = FeishuTopicCreating | FeishuTopicActive;

export interface FeishuState {
  version: 2 | 3;
  topics: Record<string, Record<string, FeishuTopicRecord>>;
  processed: Record<string, ProcessedMessage>;
}

export type TopicCreationClaim =
  | { kind: "active"; topic: FeishuTopicActive }
  | { kind: "owner"; topic: FeishuTopicCreating }
  | { kind: "waiting"; leaseExpiresAt: string };

export function normalizeTopics(
  value: Record<string, unknown>,
): FeishuState["topics"] {
  const result: FeishuState["topics"] = {};
  for (const [chatId, rawTopics] of Object.entries(value)) {
    if (!isRecord(rawTopics)) continue;
    for (const [terminalSessionId, rawTopic] of Object.entries(rawTopics)) {
      const topic = normalizeTopic(rawTopic);
      if (!topic) continue;
      const topics = result[chatId] ?? {};
      topics[terminalSessionId] = topic;
      result[chatId] = topics;
    }
  }
  return result;
}

export function normalizeTopic(value: unknown): FeishuTopicRecord | null {
  if (!isRecord(value)) return null;
  const common = {
    chatId: readString(value.chatId),
    terminalSessionId: readString(value.terminalSessionId),
    createdAt: readString(value.createdAt),
    updatedAt: readString(value.updatedAt),
  };
  if (Object.values(common).some((item) => item === null)) return null;

  if (value.status === "active") {
    const rootMessageId = readString(value.rootMessageId);
    const threadId = readNullableString(value.threadId);
    if (!rootMessageId || threadId === undefined) return null;
    return {
      status: "active",
      chatId: common.chatId!,
      terminalSessionId: common.terminalSessionId!,
      ...(typeof value.backendId === "string"
        ? { backendId: value.backendId }
        : {}),
      rootMessageId,
      threadId,
      createdAt: common.createdAt!,
      updatedAt: common.updatedAt!,
    };
  }

  if (value.status === "creating") {
    const creationUuid = readString(value.creationUuid);
    const firstRequestId = readString(value.firstRequestId);
    const ownerToken = readString(value.ownerToken);
    const leaseExpiresAt = readString(value.leaseExpiresAt);
    if (!creationUuid || !firstRequestId || !ownerToken || !leaseExpiresAt) {
      return null;
    }
    return {
      status: "creating",
      chatId: common.chatId!,
      terminalSessionId: common.terminalSessionId!,
      ...(typeof value.backendId === "string"
        ? { backendId: value.backendId }
        : {}),
      creationUuid,
      firstRequestId,
      ownerToken,
      leaseExpiresAt,
      createdAt: common.createdAt!,
      updatedAt: common.updatedAt!,
    };
  }

  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function readNullableString(value: unknown): string | null | undefined {
  return value === null ? null : (readString(value) ?? undefined);
}
