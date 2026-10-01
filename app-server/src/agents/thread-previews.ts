import { open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  formatThreadPreviewText,
  type AppServerThreadPreview,
  type AppServerThreadRef,
} from "@runweave/shared/app-server-events";
import { asRecord, readString } from "../codex/helpers.js";
import type { CodexRolloutLifecycleReader } from "../codex/lifecycle-reader.js";

type TextSnapshot = Pick<AppServerThreadPreview, "turnId" | "userText" | "agentText">;
type Entry = {
  thread: AppServerThreadRef;
  file: string | null;
  inode: number;
  offset: number;
  pending: Buffer;
  skippingLine: boolean;
  checkedAt: number;
  ready: boolean;
  valid: boolean;
  value: TextSnapshot;
  nodes: Map<string, TextSnapshot>;
  leaf: string | null;
  piCursor: string | null;
  hidden: boolean;
  reading: boolean;
};
const empty = (): TextSnapshot => ({ turnId: null, userText: null, agentText: null });
const READ_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_THREADS = 256;
const MAX_PI_NODES = 2000;

/** Demand-driven, disposable projection. HTTP only reads memory; two workers read appended bytes. */
export class ThreadPreviewReader {
  private readonly entries = new Map<string, Entry>();
  private readonly queued = new Set<Entry>();
  private readonly running = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly codex: CodexRolloutLifecycleReader) {}

  read(threads: AppServerThreadRef[]): AppServerThreadPreview[] {
    return threads.map((thread) => {
      let entry = this.entries.get(thread.threadId);
      if (entry?.thread.agent !== thread.agent ||
          (entry && entry.thread.pi?.sessionFile !== thread.pi?.sessionFile)) {
        if (entry) this.queued.delete(entry);
        entry = undefined;
      }
      if (!entry) {
        entry = {
          thread, file: null, inode: 0, offset: 0, pending: Buffer.alloc(0), skippingLine: false,
          checkedAt: 0, ready: false, valid: true, value: empty(), nodes: new Map(),
          leaf: null, piCursor: null, hidden: false, reading: false,
        };
        this.entries.set(thread.threadId, entry);
      }
      // Never show the previous turn while a newly submitted prompt is still being read.
      if (thread.lastEventId !== entry.thread.lastEventId && thread.lastHookEvent === "UserPromptSubmit") {
        entry.hidden = true;
        entry.checkedAt = 0;
      }
      if (thread.status !== entry.thread.status) entry.checkedAt = 0;
      const piCursor = thread.pi ? `${thread.pi.instanceId}:${thread.pi.sequence}:${thread.pi.leafId}` : null;
      if (piCursor !== entry.piCursor) {
        entry.checkedAt = 0;
        entry.hidden = true;
      }
      entry.thread = thread;
      const interval = !entry.file ? 30_000 : thread.status === "running" ? 3_000 : 30_000;
      if (!this.stopped && !entry.reading && Date.now() - entry.checkedAt >= interval) this.queued.add(entry);
      this.entries.delete(thread.threadId);
      this.entries.set(thread.threadId, entry);
      while (this.entries.size > MAX_THREADS) {
        const oldest = this.entries.values().next().value as Entry;
        this.entries.delete(oldest.thread.threadId);
        this.queued.delete(oldest);
      }
      this.pump();
      const available = entry.ready && entry.valid && !entry.hidden;
      return { threadId: thread.threadId, provider: thread.agent, available,
        ...(available ? entry.value : empty()) };
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.queued.clear();
    await Promise.allSettled(this.running);
    this.entries.clear();
  }

  private pump(): void {
    while (!this.stopped && this.running.size < 2 && this.queued.size) {
      const entry = [...this.queued].find((value) => !value.reading);
      if (!entry) break;
      this.queued.delete(entry);
      entry.reading = true;
      const job = this.refresh(entry).catch(() => {
        entry.ready = false;
        entry.checkedAt = Date.now();
      }).finally(() => {
        entry.reading = false;
        this.running.delete(job);
        // Yield between chunks so backfilling long histories does not monopolize HTTP.
        if (!this.stopped) setImmediate(() => this.pump());
      });
      this.running.add(job);
    }
  }

  private async refresh(entry: Entry): Promise<void> {
    const thread = entry.thread;
    const previousValue = entry.value;
    entry.checkedAt = Date.now();
    if (thread.agent !== "codex" && thread.agent !== "pi") return;
    const file = thread.agent === "pi" ? thread.pi?.sessionFile :
      entry.file ?? await this.codex.findThreadPath(thread.threadId);
    if (!file || !path.isAbsolute(file) || path.extname(file) !== ".jsonl" || await realpath(file) !== file) {
      entry.ready = false;
      return;
    }
    const handle = await open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return;
      if (entry.file !== file || entry.inode !== stat.ino || stat.size < entry.offset) {
        entry.file = file;
        entry.inode = stat.ino;
        entry.offset = 0;
        entry.pending = Buffer.alloc(0);
        entry.skippingLine = false;
        entry.ready = false;
        entry.valid = true;
        entry.value = empty();
        entry.nodes.clear();
        entry.leaf = null;
        entry.piCursor = null;
      }
      const buffer = Buffer.alloc(Math.min(READ_BYTES, stat.size - entry.offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, entry.offset);
      entry.offset += bytesRead;
      this.consume(entry, buffer.subarray(0, bytesRead));
      if (entry.offset < stat.size) {
        this.queued.add(entry);
        return;
      }
      if (thread.pi) {
        const cursor = `${thread.pi.instanceId}:${thread.pi.sequence}:${thread.pi.leafId}`;
        if (cursor !== entry.piCursor && thread.pi.leafId) {
          const selected = entry.nodes.get(thread.pi.leafId);
          if (!selected) {
            // A branch outside the bounded node window stays unavailable, never borrows another branch.
            entry.ready = false;
            return;
          }
          entry.value = selected;
          entry.leaf = thread.pi.leafId;
        }
        entry.piCursor = cursor;
      }
      entry.ready = entry.valid;
      if (entry.thread.lastEventId === thread.lastEventId && entry.value !== previousValue) entry.hidden = false;
    } finally {
      await handle.close();
    }
  }

  private consume(entry: Entry, buffer: Buffer): void {
    const bytes = Buffer.concat([entry.pending, buffer]);
    let start = 0;
    let end: number;
    while ((end = bytes.indexOf(10, start)) !== -1) {
      if (!entry.skippingLine) {
        try {
          const record = asRecord(JSON.parse(bytes.subarray(start, end).toString("utf8")));
          if (record) {
            if (entry.thread.agent === "pi") this.consumePi(entry, record);
            else this.consumeCodex(entry, record);
          }
        } catch { /* An incomplete/corrupt record is never displayed as text. */ }
      }
      entry.skippingLine = false;
      start = end + 1;
    }
    entry.pending = bytes.subarray(start);
    if (entry.skippingLine || entry.pending.length > MAX_LINE_BYTES) {
      entry.pending = Buffer.alloc(0);
      entry.skippingLine = true;
      entry.ready = false;
      entry.value = empty();
    }
  }

  private consumeCodex(entry: Entry, record: Record<string, unknown>): void {
    const item = asRecord(record.payload);
    if (!item) return;
    if (record.type === "session_meta") {
      entry.valid = item.id === entry.thread.threadId;
    } else if (record.type === "event_msg" && item.type === "task_started") {
      entry.value = { ...empty(), turnId: readString(item.turn_id) ?? readString(item.turnId) };
    } else if (record.type === "response_item" && item.type === "message") {
      const text = messageText(item.content);
      if (item.role === "user") {
        entry.value = { turnId: entry.value.turnId, userText: text, agentText: null };
      } else if (item.role === "assistant" && item.channel !== "analysis" &&
          (!item.phase || item.phase === "commentary" || item.phase === "final_answer") && text) {
        entry.value = { ...entry.value, agentText: text };
      }
    }
  }

  private consumePi(entry: Entry, record: Record<string, unknown>): void {
    if (record.type === "session") {
      entry.valid = record.id === entry.thread.threadId && record.version === 3;
      return;
    }
    const id = readString(record.id);
    if (!id) return;
    const parent = readString(record.parentId);
    let value = (parent ? entry.nodes.get(parent) : null) ?? empty();
    const message = asRecord(record.message);
    if (record.type === "message" && message?.role === "user") {
      value = { turnId: id, userText: messageText(message.content), agentText: null };
    } else if (record.type === "message" && message?.role === "assistant") {
      const text = messageText(message.content);
      if (text) value = { ...value, agentText: text };
    }
    entry.nodes.set(id, value);
    while (entry.nodes.size > MAX_PI_NODES) entry.nodes.delete(entry.nodes.keys().next().value as string);
    const data = asRecord(record.data);
    const anchor = record.type === "custom" && record.customType === "runweave.lifecycle" &&
      data?.sessionId === entry.thread.threadId;
    if (anchor || !entry.leaf || parent === entry.leaf) {
      entry.leaf = id;
      entry.value = value;
    }
    if (anchor && data?.instanceId === entry.thread.pi?.instanceId) {
      entry.piCursor = `${data.instanceId}:${data.sequence}:${data.leafId}`;
    }
  }
}

function messageText(content: unknown): string | null {
  if (typeof content === "string") return formatThreadPreviewText(content);
  if (!Array.isArray(content)) return null;
  const parts = content.map(asRecord).filter((part) => part !== null);
  const text = parts.filter((part) => part.type === "text" || part.type === "input_text" || part.type === "output_text")
    .map((part) => readString(part.text) ?? "").join("\n");
  return formatThreadPreviewText(text) ??
    (parts.some((part) => part.type === "image" || part.type === "input_image") ? "图片输入" : null);
}
