import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type DeliveryStatus = "processing" | "succeeded" | "failed" | "unknown";

export interface ProcessedMessage {
  messageId: string;
  status: DeliveryStatus;
  terminalSessionId: string;
  updatedAt: string;
}

export interface FeishuTopicCreating {
  status: "creating";
  chatId: string;
  terminalSessionId: string;
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
  rootMessageId: string;
  threadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FeishuTopicRecord = FeishuTopicCreating | FeishuTopicActive;

interface FeishuStateV2 {
  version: 2;
  topics: Record<string, Record<string, FeishuTopicRecord>>;
  processed: Record<string, ProcessedMessage>;
}

export type TopicCreationClaim =
  | { kind: "active"; topic: FeishuTopicActive }
  | { kind: "owner"; topic: FeishuTopicCreating }
  | { kind: "waiting"; leaseExpiresAt: string };

const TOPIC_CREATION_LEASE_MS = 30_000;
const PROCESSED_TTL_MS = 24 * 60 * 60 * 1000;

export class FeishuStateStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly bridgeLeasePath: string;
  private readonly activeDeliveries = new Set<string>();

  constructor(env: NodeJS.ProcessEnv) {
    const stateDir =
      env.RUNWEAVE_FEISHU_STATE_DIR?.trim() ||
      join(homedir(), ".runweave", "feishu");
    this.filePath = join(stateDir, "bridge-state.json");
    this.lockPath = join(stateDir, ".bridge-state.lock");
    this.bridgeLeasePath = join(stateDir, "bridge.pid");
  }

  async acquireBridgeLease(): Promise<{ release(): Promise<void> }> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.bridgeLeasePath, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n`, "utf8");
        let released = false;
        return {
          release: async () => {
            if (released) return;
            released = true;
            await handle.close();
            await rm(this.bridgeLeasePath, { force: true });
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        const ownerPid = Number(
          (await readFile(this.bridgeLeasePath, "utf8")).trim(),
        );
        if (Number.isInteger(ownerPid) && isProcessAlive(ownerPid)) {
          throw new Error(
            `Feishu Bridge is already running with pid ${ownerPid}`,
          );
        }
        await rm(this.bridgeLeasePath, { force: true });
      }
    }
    throw new Error("Failed to acquire Feishu Bridge process lease");
  }

  async claimTopicCreation(params: {
    chatId: string;
    terminalSessionId: string;
    requestId: string;
  }): Promise<TopicCreationClaim> {
    return await this.mutate((state) => {
      const existing = getTopic(state, params.chatId, params.terminalSessionId);
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
    ownerToken: string;
    rootMessageId: string;
    threadId: string | null;
  }): Promise<FeishuTopicActive | null> {
    return await this.mutate((state) => {
      const existing = getTopic(state, params.chatId, params.terminalSessionId);
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
    ownerToken: string;
  }): Promise<boolean> {
    return await this.mutate((state) => {
      const existing = getTopic(state, params.chatId, params.terminalSessionId);
      if (
        existing?.status !== "creating" ||
        existing.ownerToken !== params.ownerToken
      ) {
        return false;
      }
      deleteTopic(state, params.chatId, params.terminalSessionId);
      return true;
    });
  }

  async getActiveTopic(
    chatId: string,
    terminalSessionId: string,
  ): Promise<FeishuTopicActive | null> {
    const topic = getTopic(await this.readState(), chatId, terminalSessionId);
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
    rootMessageId: string;
    threadId: string;
  }): Promise<boolean> {
    return await this.mutate((state) => {
      const topic = getTopic(state, params.chatId, params.terminalSessionId);
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
    expectedRootMessageId: string;
  }): Promise<boolean> {
    return await this.mutate((state) => {
      const topic = getTopic(state, params.chatId, params.terminalSessionId);
      if (
        topic?.status !== "active" ||
        topic.rootMessageId !== params.expectedRootMessageId
      ) {
        return false;
      }
      deleteTopic(state, params.chatId, params.terminalSessionId);
      return true;
    });
  }

  async cleanupMissingSessions(
    existingTerminalSessionIds: ReadonlySet<string>,
  ): Promise<number> {
    return await this.mutate((state) => {
      let removed = 0;
      for (const [chatId, topics] of Object.entries(state.topics)) {
        for (const [terminalSessionId, topic] of Object.entries(topics)) {
          if (
            topic.status === "active" &&
            !existingTerminalSessionIds.has(terminalSessionId)
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
        processed.status = "unknown";
        processed.updatedAt = new Date().toISOString();
        recovered += 1;
      }
      return recovered;
    });
  }

  async beginDelivery(
    messageId: string,
    terminalSessionId: string,
  ): Promise<DeliveryStatus | "started"> {
    try {
      return await this.mutate((state) => {
        const existing = state.processed[messageId];
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
        }
      });
    } finally {
      this.activeDeliveries.delete(messageId);
    }
  }

  private async mutate<T>(operation: (state: FeishuStateV2) => T): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lock = await this.acquireLock();
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
      await lock.close();
      await rm(this.lockPath, { force: true });
    }
  }

  private async acquireLock() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        return await open(this.lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error("Timed out waiting for Feishu state lock");
  }

  private async readState(): Promise<FeishuStateV2> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as {
        version?: unknown;
        topics?: unknown;
        processed?: unknown;
      };
      return {
        version: 2,
        topics:
          parsed.version === 2 && isRecord(parsed.topics)
            ? normalizeTopics(parsed.topics)
            : {},
        processed: isRecord(parsed.processed)
          ? (parsed.processed as FeishuStateV2["processed"])
          : {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 2, topics: {}, processed: {} };
      }
      throw error;
    }
  }
}

function normalizeTopics(
  value: Record<string, unknown>,
): FeishuStateV2["topics"] {
  const result: FeishuStateV2["topics"] = {};
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

function normalizeTopic(value: unknown): FeishuTopicRecord | null {
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

function getTopic(
  state: FeishuStateV2,
  chatId: string,
  terminalSessionId: string,
): FeishuTopicRecord | undefined {
  return state.topics[chatId]?.[terminalSessionId];
}

function setTopic(state: FeishuStateV2, topic: FeishuTopicRecord): void {
  const topics = state.topics[topic.chatId] ?? {};
  topics[topic.terminalSessionId] = topic;
  state.topics[topic.chatId] = topics;
}

function deleteTopic(
  state: FeishuStateV2,
  chatId: string,
  terminalSessionId: string,
): void {
  const topics = state.topics[chatId];
  if (!topics) return;
  delete topics[terminalSessionId];
  if (Object.keys(topics).length === 0) delete state.topics[chatId];
}

function pruneProcessed(state: FeishuStateV2): void {
  const now = Date.now();
  for (const [messageId, processed] of Object.entries(state.processed)) {
    if (Date.parse(processed.updatedAt) + PROCESSED_TTL_MS <= now) {
      delete state.processed[messageId];
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function readNullableString(value: unknown): string | null | undefined {
  return value === null ? null : (readString(value) ?? undefined);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
