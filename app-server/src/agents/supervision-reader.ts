import { constants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  ConversationMessage,
  SupervisionConversationResponse,
} from "@runweave/shared/terminal/conversation";
import type { CodexRolloutLifecycleReader } from "../codex/lifecycle-reader.js";
import {
  ConversationReadError,
  conversationText,
  isInjectedCodexContext,
} from "./conversation-source.js";
import { SemanticJsonStream } from "./semantic-json-stream.js";

type Entry = {
  id: string;
  role: "user" | "assistant";
  offset: number;
  length: number;
  sourceOffset: number;
  digest: string;
  turnId?: string;
  ordinaryUser?: boolean;
};
type Index = {
  identity: string;
  version?: string;
  source: string;
  sourceSize?: number;
  sourceMtime?: number;
  offset: number;
  valid: boolean;
  turnId?: string;
  entries: Entry[];
  bytes: number;
  error?: SupervisionConversationResponse["runtimeError"];
};
type Cached = {
  index: Index;
  scanner?: SemanticJsonStream;
  position: number;
  used: number;
};
const BATCH = 4 * 1024 * 1024;
const CACHE_BUDGET = 256 * 1024 * 1024;
const METADATA_BUDGET = 8 * 1024 * 1024;
const SOFT_INPUT = 32 * 1024;
const HARD_INPUT = 180_000;

/** Rebuildable, bounded cache. Raw rollouts and decision archives are never removed here. */
export class SupervisionConversationReader {
  private readonly caches = new Map<string, Cached>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly jobs = new Map<
    string,
    Promise<SupervisionConversationResponse>
  >();
  constructor(
    private readonly paths: CodexRolloutLifecycleReader,
    private readonly directory: string,
  ) {}
  read(threadId: string, requiredIds: string[] = []) {
    // Requests with different selections serialize behind the same source writer.
    const job = this.queue
      .catch(() => undefined)
      .then(() => this.readSource(threadId, requiredIds));
    this.queue = job.catch(() => {
      this.caches.delete(createHash("sha256").update(threadId).digest("hex"));
    });
    this.jobs.set(threadId, job);
    void job
      .finally(() => {
        if (this.jobs.get(threadId) === job) this.jobs.delete(threadId);
      })
      .catch(() => undefined);
    return job;
  }
  private async readSource(
    threadId: string,
    requiredIds: string[],
  ): Promise<SupervisionConversationResponse> {
    const empty: SupervisionConversationResponse = {
      threadId,
      provider: "codex",
      availability: "source_missing",
      readAt: new Date().toISOString(),
      partial: false,
      turns: [],
      indexing: false,
    };
    const source = await this.paths.findThreadPath(threadId);
    if (!source || (await realpath(source).catch(() => null)) !== source)
      return empty;
    const handle = await open(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) return empty;
      const prefix = Buffer.alloc(Math.min(1024, info.size));
      await handle.read(prefix, 0, prefix.length, 0);
      const sessionEnd = prefix.indexOf(10);
      const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}:${createHash(
        "sha256",
      )
        .update(sessionEnd >= 0 ? prefix.subarray(0, sessionEnd) : prefix)
        .digest("hex")}`;
      const key = createHash("sha256").update(threadId).digest("hex");
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const metaPath = path.join(this.directory, `${key}.json`);
      const textPath = path.join(this.directory, `${key}.text`);
      let cached = this.caches.get(key);
      if (!cached) {
        let index: Index | undefined;
        try {
          if ((await stat(metaPath)).size <= METADATA_BUDGET)
            index = JSON.parse(await readFile(metaPath, "utf8")) as Index;
          if (!index || (await stat(textPath)).size < index.bytes)
            index = undefined;
        } catch {
          index = undefined;
        }
        cached = {
          index: index ?? {
            identity,
            source,
            offset: 0,
            valid: false,
            entries: [],
            bytes: 0,
          },
          position: index?.offset ?? 0,
          used: Date.now(),
        };
        this.caches.set(key, cached);
      }
      const rewritten =
        info.size < (cached.index.sourceSize ?? 0) ||
        (info.size === cached.index.sourceSize &&
          info.mtimeMs !== cached.index.sourceMtime);
      if (
        cached.index.identity !== identity ||
        cached.index.source !== source ||
        cached.position > info.size ||
        rewritten
      ) {
        cached = {
          index: {
            identity,
            version: `${identity}:${randomUUID()}`,
            source,
            offset: 0,
            valid: false,
            entries: [],
            bytes: 0,
          },
          position: 0,
          used: Date.now(),
        };
        this.caches.set(key, cached);
      }
      cached.used = Date.now();
      const index = cached.index;
      const firstNewEntry = index.entries.length;
      const additions: string[] = [];
      let appended = 0;
      // A partial record's parser stays in bounded memory; durable resume begins at the last complete record.
      const consume = (record: Record<string, unknown>, offset: number) => {
        const item = record.payload as Record<string, unknown> | undefined;
        if (record.type === "runweave_invalid_record")
          throw new ConversationReadError(
            422,
            "CONTEXT_SOURCE_INVALID",
            "原始会话包含无法解析的记录",
          );
        if (record.type === "runweave_text_too_large")
          throw new ConversationReadError(
            413,
            "CONTEXT_BUDGET_EXCEEDED",
            "必要会话文本超过读取预算",
          );
        if (!item) return;
        if (record.type === "session_meta") {
          if (item.id !== threadId)
            throw new ConversationReadError(
              409,
              "CONTEXT_SOURCE_CHANGED",
              "会话来源身份不一致",
            );
          index.valid = true;
          return;
        }
        if (record.type === "event_msg" && item.type === "task_started") {
          index.turnId =
            typeof item.turn_id === "string"
              ? item.turn_id
              : typeof item.turnId === "string"
                ? item.turnId
                : undefined;
          delete index.error;
          return;
        }
        if (
          record.type === "event_msg" &&
          item.type === "task_complete" &&
          item.error
        ) {
          const error = item.error as Record<string, unknown>;
          index.error = {
            turnId: index.turnId,
            code: String(error.codex_error_info ?? "agent_error"),
            message: String(error.message ?? "Agent 任务因错误结束"),
          };
          return;
        }
        if (
          record.type !== "response_item" ||
          item.type !== "message" ||
          !["user", "assistant"].includes(String(item.role))
        )
          return;
        const phase = item.phase ?? item.channel;
        if (
          item.role === "assistant" &&
          phase != null &&
          !["final", "final_answer"].includes(String(phase))
        )
          return;
        const parts =
          item.content && typeof item.content === "object"
            ? Object.values(
                item.content as Record<string, Record<string, unknown>>,
              )
            : [];
        const text = conversationText(
          typeof item.content === "string" ? item.content : parts,
        );
        if (
          !text.trim() ||
          (item.role === "user" && isInjectedCodexContext(text))
        )
          return;
        if (text.includes("[runweave:source_text_exceeds_budget]"))
          throw new ConversationReadError(
            413,
            "CONTEXT_BUDGET_EXCEEDED",
            "必要会话文本超过读取预算",
          );
        const message: ConversationMessage = {
          id: typeof item.id === "string" ? item.id : `record:${offset}`,
          role: item.role as "user" | "assistant",
          text,
          ...(index.turnId ? { rawTurnId: index.turnId } : {}),
          ...(item.role === "assistant" ? { phase: "final" } : {}),
          ...(typeof record.timestamp === "string"
            ? { createdAt: record.timestamp }
            : {}),
        };
        const body = JSON.stringify(message) + "\n";
        const length = Buffer.byteLength(body);
        index.entries.push({
          id: message.id,
          role: message.role,
          offset: index.bytes + appended,
          length,
          sourceOffset: offset,
          digest: createHash("sha256").update(text).digest("hex"),
          turnId: index.turnId,
          ordinaryUser:
            message.role === "user" &&
            !message.text.includes("[runweave-task-supervision:") &&
            !message.text.startsWith("<hook_prompt"),
        });
        additions.push(body);
        appended += length;
      };
      if (!cached.scanner)
        cached.scanner = new SemanticJsonStream(consume, index.offset);
      else cached.scanner.setConsumer(consume);
      if (cached.position < info.size) {
        const chunk = Buffer.alloc(256 * 1024);
        const end = Math.min(info.size, cached.position + BATCH);
        while (cached.position < end) {
          const { bytesRead } = await handle.read(
            chunk,
            0,
            Math.min(chunk.length, end - cached.position),
            cached.position,
          );
          if (!bytesRead) break;
          cached.scanner.feed(chunk.subarray(0, bytesRead));
          cached.position += bytesRead;
        }
        // Payloads are a sliding cache. Metadata keeps raw offsets so an evicted source remains readable.
        if (index.bytes + appended > 16 * 1024 * 1024) {
          for (let i = 0; i < index.entries.length; i++) {
            const entry = index.entries[i]!;
            entry.offset = i < firstNewEntry ? -1 : entry.offset - index.bytes;
          }
          index.bytes = 0;
        }
        await this.prune(key, appended + METADATA_BUDGET);
        const file = await open(textPath, index.bytes ? "r+" : "w", 0o600);
        try {
          await file.truncate(index.bytes);
          if (additions.length)
            await file.write(additions.join(""), index.bytes, "utf8");
          index.bytes += appended;
        } finally {
          await file.close();
        }
        index.offset = cached.scanner.committedOffset;
        index.sourceSize = info.size;
        index.sourceMtime = info.mtimeMs;
        const metadata = JSON.stringify(index);
        if (Buffer.byteLength(metadata) > METADATA_BUDGET)
          throw new ConversationReadError(
            413,
            "CONTEXT_INDEX_BUDGET",
            "语义索引元数据超过缓存预算",
          );
        await writeFile(`${metaPath}.tmp`, metadata, { mode: 0o600 });
        await rename(`${metaPath}.tmp`, metaPath);
      }
      await this.prune(key);
      const indexing = cached.position < info.size;
      if (indexing)
        return {
          ...empty,
          availability: "available",
          indexing: true,
          scannedBytes: cached.position,
          sourceBytes: info.size,
        };
      if (!index.valid) return empty;
      const required = new Set(requiredIds);
      const firstUser = [...index.entries]
        .reverse()
        .find((entry) => entry.ordinaryUser);
      const latestUser = [...index.entries]
        .reverse()
        .find((entry) => entry.role === "user");
      const latest = index.entries.at(-1);
      if (firstUser) required.add(firstUser.id);
      if (latestUser) required.add(latestUser.id);
      if (latest) required.add(latest.id);
      const selected = new Set<Entry>();
      let bytes = 0;
      for (const entry of index.entries)
        if (required.has(entry.id)) {
          selected.add(entry);
          bytes += entry.length;
          required.delete(entry.id);
        }
      if (required.size)
        throw new ConversationReadError(
          422,
          "CONTEXT_SOURCE_MISSING",
          "当前任务必要证据在原会话中缺失",
        );
      for (let i = index.entries.length - 1; i >= 0; i--) {
        const entry = index.entries[i]!;
        if (selected.has(entry)) continue;
        if (bytes + entry.length > SOFT_INPUT && selected.size > 1) break;
        selected.add(entry);
        bytes += entry.length;
      }
      if (bytes > HARD_INPUT)
        throw new ConversationReadError(
          413,
          "CONTEXT_BUDGET_EXCEEDED",
          "当前任务必要原文超过输入硬上限",
        );
      const textFile = await open(textPath, "r");
      const messages: ConversationMessage[] = [];
      try {
        for (const entry of index.entries)
          if (selected.has(entry)) {
            if (entry.offset < 0) {
              messages.push(await this.readOriginal(handle, entry, info.size));
              continue;
            }
            const buffer = Buffer.alloc(entry.length);
            const { bytesRead } = await textFile.read(
              buffer,
              0,
              buffer.length,
              entry.offset,
            );
            if (bytesRead !== entry.length)
              throw new ConversationReadError(
                503,
                "CONTEXT_CACHE_INVALID",
                "语义缓存不完整，等待重建",
              );
            const message = JSON.parse(
              buffer.toString("utf8"),
            ) as ConversationMessage;
            if (
              message.id !== entry.id ||
              createHash("sha256").update(message.text).digest("hex") !==
                entry.digest
            ) {
              await rm(metaPath, { force: true });
              throw new ConversationReadError(
                503,
                "CONTEXT_INDEXING",
                "语义缓存校验失败，正在重建",
              );
            }
            messages.push(message);
          }
      } finally {
        await textFile.close();
      }
      return {
        ...empty,
        availability: "available",
        indexing: false,
        sourceVersion: index.version ?? identity,
        scannedBytes: cached.position,
        sourceBytes: info.size,
        runtimeError: index.error,
        turns: messages.map((message) => ({
          id: message.id,
          rawTurnId: message.rawTurnId,
          messages: [message],
        })),
      };
    } finally {
      await handle.close();
    }
  }
  private async readOriginal(
    handle: Awaited<ReturnType<typeof open>>,
    entry: Entry,
    size: number,
  ): Promise<ConversationMessage> {
    let record: Record<string, unknown> | undefined;
    const scanner = new SemanticJsonStream((value) => {
      record ??= value;
    }, entry.sourceOffset);
    let position = entry.sourceOffset;
    const chunk = Buffer.alloc(256 * 1024);
    while (!record && position < size) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, size - position),
        position,
      );
      if (!bytesRead) break;
      const bytes = chunk.subarray(0, bytesRead);
      const end = bytes.indexOf(10);
      scanner.feed(end < 0 ? bytes : bytes.subarray(0, end + 1));
      position += bytesRead;
      if (position % BATCH < chunk.length)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const payload = record?.payload as Record<string, unknown> | undefined;
    if (!payload || record?.type !== "response_item")
      throw new ConversationReadError(
        422,
        "CONTEXT_SOURCE_CHANGED",
        "证据原文已变化",
      );
    const text = conversationText(
      typeof payload.content === "string"
        ? payload.content
        : Object.values((payload.content ?? {}) as Record<string, unknown>),
    );
    if (createHash("sha256").update(text).digest("hex") !== entry.digest)
      throw new ConversationReadError(
        409,
        "CONTEXT_SOURCE_CHANGED",
        "证据原文内容已变化",
      );
    return {
      id: entry.id,
      role: entry.role,
      text,
      ...(entry.turnId ? { rawTurnId: entry.turnId } : {}),
      ...(entry.role === "assistant" ? { phase: "final" as const } : {}),
      ...(typeof record?.timestamp === "string"
        ? { createdAt: record.timestamp }
        : {}),
    };
  }
  private async prune(current: string, reserveBytes = 0) {
    const files = await readdir(this.directory, { withFileTypes: true });
    const entries = await Promise.all(
      files
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const file = path.join(this.directory, entry.name);
          const info = await stat(file);
          return {
            file,
            name: entry.name,
            size: info.size,
            time: info.mtimeMs,
          };
        }),
    );
    let total = entries.reduce((sum, entry) => sum + entry.size, reserveBytes);
    for (const entry of entries.sort((a, b) => a.time - b.time)) {
      if (total <= CACHE_BUDGET) break;
      const key = entry.name.split(".")[0]!;
      if (key === current) continue;
      await rm(entry.file, { force: true });
      total -= entry.size;
      this.caches.delete(key);
    }
    if (total > CACHE_BUDGET)
      throw new ConversationReadError(
        503,
        "CONTEXT_CACHE_BUDGET",
        "语义缓存繁忙，未读取不完整资料",
      );
    while (this.caches.size > 4) {
      const oldest = [...this.caches]
        .filter(([key]) => key !== current)
        .sort((a, b) => a[1].used - b[1].used)[0];
      if (!oldest) break;
      this.caches.delete(oldest[0]);
    }
  }
}
