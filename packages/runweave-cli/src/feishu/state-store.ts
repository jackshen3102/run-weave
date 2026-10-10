import {
  normalizeTopics,
  normalizeTopic,
  isRecord,
  type DeliveryStatus,
  type FeishuTopicActive,
  type FeishuTopicCreating,
  type FeishuTopicRecord,
  type FeishuState,
  type ProcessedMessage,
  type TopicCreationClaim,
} from "./state-schema.js";
export type {
  DeliveryStatus,
  FeishuTopicActive,
  FeishuTopicCreating,
  FeishuTopicRecord,
  FeishuState,
  ProcessedMessage,
  TopicCreationClaim,
} from "./state-schema.js";
import { configurationPath } from "@runweave/config-node";
import type { FeishuInboundMessageEvent } from "./bridge-message-handler.js";
import { acquireProcessLock } from "../runtime/process-lock.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const TOPIC_CREATION_LEASE_MS = 30_000;
const PROCESSED_TTL_MS = 24 * 60 * 60 * 1000;

export class FeishuStateStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly bridgeLeasePath: string;
  private readonly activeDeliveries = new Set<string>();

  constructor(
    private readonly options: { directory?: string; hub?: boolean } = {},
  ) {
    const stateDir =
      options.directory ??
      configurationPath("storage.feishuDirectory", "feishu");
    this.filePath = join(stateDir, "bridge-state.json");
    this.lockPath = join(stateDir, ".bridge-state.lock");
    this.bridgeLeasePath = join(stateDir, "bridge.pid");
  }

  async acquireBridgeLease(): Promise<{ release(): Promise<void> }> {
    return acquireProcessLock(this.bridgeLeasePath);
  }

  async claimTopicCreation(params: {
    chatId: string;
    terminalSessionId: string;
    backendId?: string;
    requestId: string;
  }): Promise<TopicCreationClaim> {
    return await this.mutate((state) => {
      const existing = getTopic(
        state,
        params.chatId,
        params.terminalSessionId,
        this.backend(params.backendId),
      );
      if (existing?.status === "active") {
        return { kind: "active", topic: existing };
      }

      const now = new Date();
      if (
        existing?.status === "creating" &&
        Date.parse(existing.leaseExpiresAt) > now.getTime()
      ) {
        return {
          kind: "waiting",
          leaseExpiresAt: existing.leaseExpiresAt,
        };
      }

      const topic: FeishuTopicCreating = existing
        ? {
            ...existing,
            ownerToken: randomUUID(),
            leaseExpiresAt: new Date(
              now.getTime() + TOPIC_CREATION_LEASE_MS,
            ).toISOString(),
            updatedAt: now.toISOString(),
          }
        : {
            status: "creating",
            chatId: params.chatId,
            terminalSessionId: params.terminalSessionId,
            backendId: this.backend(params.backendId),
            creationUuid: randomUUID(),
            firstRequestId: params.requestId,
            ownerToken: randomUUID(),
            leaseExpiresAt: new Date(
              now.getTime() + TOPIC_CREATION_LEASE_MS,
            ).toISOString(),
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          };
      setTopic(state, topic);
      return { kind: "owner", topic };
    });
  }

  async activateTopic(params: {
    chatId: string;
    terminalSessionId: string;
    backendId?: string;
    ownerToken: string;
    rootMessageId: string;
    threadId: string | null;
  }): Promise<FeishuTopicActive | null> {
    return await this.mutate((state) => {
      const existing = getTopic(
        state,
        params.chatId,
        params.terminalSessionId,
        this.backend(params.backendId),
      );
      if (existing?.status === "active") return existing;
      if (
        existing?.status !== "creating" ||
        existing.ownerToken !== params.ownerToken
      ) {
        return null;
      }
      const topic: FeishuTopicActive = {
        status: "active",
        chatId: existing.chatId,
        terminalSessionId: existing.terminalSessionId,
        backendId: existing.backendId,
        rootMessageId: params.rootMessageId,
        threadId: params.threadId,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      };
      setTopic(state, topic);
      return topic;
    });
  }

  async releaseTopicCreation(params: {
    chatId: string;
    terminalSessionId: string;
    backendId?: string;
    ownerToken: string;
  }): Promise<boolean> {
    return await this.mutate((state) => {
      const existing = getTopic(
        state,
        params.chatId,
        params.terminalSessionId,
        this.backend(params.backendId),
      );
      if (
        existing?.status !== "creating" ||
        existing.ownerToken !== params.ownerToken
      ) {
        return false;
      }
      deleteTopic(
        state,
        params.chatId,
        params.terminalSessionId,
        this.backend(params.backendId),
      );
      return true;
    });
  }

  async getActiveTopic(
    chatId: string,
    terminalSessionId: string,
    backendId?: string,
  ): Promise<FeishuTopicActive | null> {
    const topic = getTopic(
      await this.readState(),
      chatId,
      terminalSessionId,
      this.backend(backendId),
    );
    return topic?.status === "active" ? topic : null;
  }

  async findActiveTopicByRoot(
    chatId: string,
    rootMessageId: string,
  ): Promise<FeishuTopicActive | null> {
    const state = await this.readState();
    for (const topic of Object.values(state.topics[chatId] ?? {})) {
      if (topic.status === "active" && topic.rootMessageId === rootMessageId) {
        return topic;
      }
    }
    return null;
  }

  async recordTopicThread(params: {
    chatId: string;
    terminalSessionId: string;
    backendId?: string;
    rootMessageId: string;
    threadId: string;
  }): Promise<boolean> {
    return await this.mutate((state) => {
      const topic = getTopic(
        state,
        params.chatId,
        params.terminalSessionId,
        this.backend(params.backendId),
      );
      if (
        topic?.status !== "active" ||
        topic.rootMessageId !== params.rootMessageId ||
        (topic.threadId !== null && topic.threadId !== params.threadId)
      ) {
        return false;
      }
      if (topic.threadId === null) {
        topic.threadId = params.threadId;
        topic.updatedAt = new Date().toISOString();
      }
      return true;
    });
  }

  async clearTopic(params: {
    chatId: string;
    terminalSessionId: string;
    backendId?: string;
    expectedRootMessageId: string;
  }): Promise<boolean> {
    return await this.mutate((state) => {
      const topic = getTopic(
        state,
        params.chatId,
        params.terminalSessionId,
        this.backend(params.backendId),
      );
      if (
        topic?.status !== "active" ||
        topic.rootMessageId !== params.expectedRootMessageId
      ) {
        return false;
      }
      deleteTopic(
        state,
        params.chatId,
        params.terminalSessionId,
        this.backend(params.backendId),
      );
      return true;
    });
  }

  async cleanupMissingSessions(
    existingTerminalSessionIds: ReadonlySet<string>,
    backendId?: string,
  ): Promise<number> {
    const scope = this.backend(backendId);
    return await this.mutate((state) => {
      let removed = 0;
      for (const [chatId, topics] of Object.entries(state.topics)) {
        for (const [terminalSessionId, topic] of Object.entries(topics)) {
          if (
            topic.status === "active" &&
            topic.backendId === scope &&
            !existingTerminalSessionIds.has(topic.terminalSessionId)
          ) {
            delete topics[terminalSessionId];
            removed += 1;
          }
        }
        if (Object.keys(topics).length === 0) delete state.topics[chatId];
      }
      return removed;
    });
  }

  async recoverInterruptedDeliveries(): Promise<number> {
    return await this.mutate((state) => {
      let recovered = 0;
      for (const processed of Object.values(state.processed)) {
        if (processed.status !== "processing") continue;
        processed.status =
          processed.event && !processed.inputAttempted ? "waiting" : "unknown";
        processed.updatedAt = new Date().toISOString();
        recovered += 1;
      }
      return recovered;
    });
  }

  async queueEvent(
    event: FeishuInboundMessageEvent,
    terminalSessionId: string,
    backendId?: string,
  ): Promise<boolean> {
    return this.mutate((state) => {
      if (state.processed[event.message.message_id]) return false;
      state.processed[event.message.message_id] = {
        messageId: event.message.message_id,
        terminalSessionId,
        backendId: this.backend(backendId),
        status: "waiting",
        event,
        expiresAt: new Date(
          Math.min(
            Date.now(),
            Number(event.message.create_time) || Date.now(),
          ) + 120_000,
        ).toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return true;
    });
  }

  async waitingEvents(): Promise<FeishuInboundMessageEvent[]> {
    const state = await this.readState();
    return Object.values(state.processed)
      .filter((entry) => entry.status === "waiting" && entry.event)
      .map((entry) => entry.event!);
  }

  async delivery(messageId: string): Promise<ProcessedMessage | undefined> {
    return (await this.readState()).processed[messageId];
  }

  async markInputAttempt(messageId: string, attempted: boolean): Promise<void> {
    await this.mutate((state) => {
      const entry = state.processed[messageId];
      if (!entry || entry.status !== "processing")
        throw new Error("Delivery is not processing");
      entry.inputAttempted = attempted;
    });
  }

  async beginDelivery(
    messageId: string,
    terminalSessionId: string,
    backendId?: string,
  ): Promise<DeliveryStatus | "started"> {
    try {
      return await this.mutate((state) => {
        const existing = state.processed[messageId];
        if (existing?.status === "waiting") {
          existing.status = "processing";
          this.activeDeliveries.add(messageId);
          return "started";
        }
        if (existing) {
          if (
            existing.status === "processing" &&
            !this.activeDeliveries.has(messageId)
          ) {
            existing.status = "unknown";
            existing.updatedAt = new Date().toISOString();
            return "unknown";
          }
          return existing.status;
        }
        state.processed[messageId] = {
          messageId,
          status: "processing",
          terminalSessionId,
          backendId: this.backend(backendId),
          updatedAt: new Date().toISOString(),
        };
        this.activeDeliveries.add(messageId);
        return "started";
      });
    } catch (error) {
      this.activeDeliveries.delete(messageId);
      throw error;
    }
  }

  async finishDelivery(
    messageId: string,
    status: Exclude<DeliveryStatus, "processing">,
  ): Promise<void> {
    try {
      await this.mutate((state) => {
        const existing = state.processed[messageId];
        if (existing?.status === "processing") {
          existing.status = status;
          existing.updatedAt = new Date().toISOString();
          if (status !== "waiting") delete existing.event;
        }
      });
    } finally {
      this.activeDeliveries.delete(messageId);
    }
  }

  private async mutate<T>(operation: (state: FeishuState) => T): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lock = await acquireProcessLock(this.lockPath, 2_000);
    try {
      const state = await this.readState();
      pruneProcessed(state);
      const result = operation(state);
      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(tempPath, this.filePath);
      return result;
    } finally {
      await lock.release();
    }
  }

  private backend(backendId?: string): string | undefined {
    if (
      this.options.hub
        ? !backendId || !/^[a-f0-9]{64}$/.test(backendId)
        : backendId !== undefined
    )
      throw new Error("Invalid Feishu backend scope");
    return backendId;
  }

  private async readState(): Promise<FeishuState> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as {
        version?: unknown;
        topics?: unknown;
        processed?: unknown;
      };
      if (this.options.hub ? parsed.version !== 3 : parsed.version !== 1 && parsed.version !== 2)
        throw new Error(
          "Feishu state role/version mismatch; use offline migration",
        );
      if (this.options.hub) {
        if (!isRecord(parsed.topics) || !isRecord(parsed.processed))
          throw new Error("Invalid hub state");
        for (const [chatId, topics] of Object.entries(parsed.topics)) {
          if (!isRecord(topics)) throw new Error("Invalid hub topics");
          for (const [key, raw] of Object.entries(topics)) {
            const topic = normalizeTopic(raw);
            if (
              !topic ||
              topic.chatId !== chatId ||
              !topic.backendId ||
              this.backend(topic.backendId) !== topic.backendId ||
              key !== topicKey(topic.terminalSessionId, topic.backendId)
            )
              throw new Error("Invalid hub topic binding");
          }
        }
        for (const entry of Object.values(parsed.processed)) {
          if (
            !isRecord(entry) ||
            !entry.backendId ||
            !this.backend(String(entry.backendId))
          )
            throw new Error("Invalid hub delivery binding");
        }
      }
      return {
        version: this.options.hub ? 3 : 2,
        topics:
          (parsed.version === 2 || parsed.version === 3) &&
          isRecord(parsed.topics)
            ? normalizeTopics(parsed.topics)
            : {},
        processed: isRecord(parsed.processed)
          ? (parsed.processed as FeishuState["processed"])
          : {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: this.options.hub ? 3 : 2, topics: {}, processed: {} };
      }
      throw error;
    }
  }
}

function getTopic(
  state: FeishuState,
  chatId: string,
  terminalSessionId: string,
  backendId?: string,
): FeishuTopicRecord | undefined {
  return state.topics[chatId]?.[topicKey(terminalSessionId, backendId)];
}

function setTopic(state: FeishuState, topic: FeishuTopicRecord): void {
  const topics = state.topics[topic.chatId] ?? {};
  topics[topicKey(topic.terminalSessionId, topic.backendId)] = topic;
  state.topics[topic.chatId] = topics;
}

function deleteTopic(
  state: FeishuState,
  chatId: string,
  terminalSessionId: string,
  backendId?: string,
): void {
  const topics = state.topics[chatId];
  if (!topics) return;
  delete topics[topicKey(terminalSessionId, backendId)];
  if (Object.keys(topics).length === 0) delete state.topics[chatId];
}

function pruneProcessed(state: FeishuState): void {
  const now = Date.now();
  for (const [messageId, processed] of Object.entries(state.processed)) {
    if (Date.parse(processed.updatedAt) + PROCESSED_TTL_MS <= now) {
      delete state.processed[messageId];
    }
  }
}

export function topicKey(
  terminalSessionId: string,
  backendId?: string,
): string {
  return backendId
    ? JSON.stringify([backendId, terminalSessionId])
    : terminalSessionId;
}
