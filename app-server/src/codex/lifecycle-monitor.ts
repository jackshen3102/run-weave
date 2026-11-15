import { statSync, watch, type FSWatcher, type Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { AppServerThreadRef } from "@runweave/shared/app-server-events";
import { parseLatestLifecycle, type CodexRolloutLifecycle, type CodexRolloutLifecycleReaderLike } from "./lifecycle-reader.js";

const MAX_THREADS = 100;
const MAX_IN_FLIGHT = 4;
const MAX_LINE_BYTES = 256 * 1024;
const READ_BATCH_BYTES = 1024 * 1024;

export interface CodexLifecycleHint {
  threadId: string;
  generation: number;
  lifecycle: CodexRolloutLifecycle;
  signature: string;
}

interface Subscription {
  thread: AppServerThreadRef;
  generation: number;
  file?: string;
  identity?: string;
  watcher?: FSWatcher;
  timer?: NodeJS.Timeout;
  initialized: boolean;
  baseline: boolean;
  offset: number;
  partial: Buffer;
  skipLine: boolean;
  ignoredTurn: string | null;
  promptTurn: string | null;
  awaitingStart: boolean;
  start: CodexRolloutLifecycle | null;
  latest: CodexRolloutLifecycle | null;
}

/** File notifications are hints; only the reconciler can commit a verified observation. */
export class CodexLifecycleMonitor {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly lastTurns = new Map<string, string>();
  private readonly pending = new Set<Subscription>();
  private readonly jobs = new Set<Promise<void>>();
  private generation = 0;
  private stopped = false;
  private reads = 0;
  private bytesRead = 0;
  private hints = 0;

  constructor(
    private readonly reader: CodexRolloutLifecycleReaderLike,
    private readonly onHint: (hint: CodexLifecycleHint) => Promise<void>,
  ) {}

  track(thread: AppServerThreadRef, newPrompt = false): void {
    const active = thread.agent === "codex" && thread.terminalSessionId && thread.terminalPanelId &&
      (thread.status === "running" || thread.status === "starting");
    let entry = this.subscriptions.get(thread.threadId);
    if (!active || this.stopped) { if (entry) this.remove(entry); return; }
    if (entry && (entry.thread.terminalSessionId !== thread.terminalSessionId ||
        entry.thread.terminalPanelId !== thread.terminalPanelId)) {
      this.remove(entry); entry = undefined;
    }
    if (!entry) {
      if (this.subscriptions.size >= MAX_THREADS) return;
      entry = { thread, generation: ++this.generation, initialized: false, baseline: true,
        offset: 0, partial: Buffer.alloc(0), skipLine: false, ignoredTurn: this.lastTurns.get(thread.threadId) ?? null,
        promptTurn: null, awaitingStart: thread.lastHookEvent === "UserPromptSubmit", start: null, latest: null };
      this.subscriptions.set(thread.threadId, entry);
      this.schedule(entry);
    } else {
      if (newPrompt) {
        entry.generation = ++this.generation;
        entry.ignoredTurn = entry.promptTurn ?? entry.ignoredTurn;
        entry.promptTurn = null;
        entry.awaitingStart = true;
        entry.start = null;
        entry.latest = null;
        entry.baseline = true;
        this.schedule(entry);
      }
      entry.thread = thread;
    }
  }

  sync(threads: AppServerThreadRef[]): void {
    const ids = new Set(threads.map((thread) => thread.threadId));
    for (const entry of this.subscriptions.values()) if (!ids.has(entry.thread.threadId)) this.remove(entry);
    for (const thread of threads) this.track(thread);
  }

  request(threadId: string): void {
    const entry = this.subscriptions.get(threadId);
    if (entry) this.schedule(entry);
  }

  isCurrent(hint: CodexLifecycleHint): boolean {
    const entry = this.subscriptions.get(hint.threadId);
    if (this.stopped || !entry?.file || entry.generation !== hint.generation ||
      entry.start?.turnId !== hint.lifecycle.turnId || entry.latest?.cursor !== hint.lifecycle.cursor) return false;
    try { return signature(statSync(entry.file)) === hint.signature; } catch { return false; }
  }

  getStatusSnapshot() {
    return { subscriptions: this.subscriptions.size, pending: this.pending.size, inFlight: this.jobs.size,
      reads: this.reads, bytesRead: this.bytesRead, hints: this.hints };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const entry of this.subscriptions.values()) this.remove(entry);
    await Promise.allSettled([...this.jobs]);
    this.lastTurns.clear();
  }

  private current(entry: Subscription, generation: number): boolean {
    return !this.stopped && this.subscriptions.get(entry.thread.threadId) === entry && entry.generation === generation;
  }

  private remove(entry: Subscription): void {
    if (this.subscriptions.get(entry.thread.threadId) !== entry) return;
    const turn = entry.promptTurn ?? entry.start?.turnId;
    if (turn) {
      this.lastTurns.delete(entry.thread.threadId);
      this.lastTurns.set(entry.thread.threadId, turn);
      if (this.lastTurns.size > MAX_THREADS) this.lastTurns.delete(this.lastTurns.keys().next().value!);
    }
    entry.watcher?.close();
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(entry);
    this.subscriptions.delete(entry.thread.threadId);
  }

  private schedule(entry: Subscription): void {
    if (this.stopped || entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.subscriptions.get(entry.thread.threadId) !== entry || this.stopped) return;
      this.pending.add(entry);
      this.pump();
    }, 100);
    entry.timer.unref();
  }

  private readonly reading = new Set<Subscription>();

  private pump(): void {
    for (const entry of this.pending) {
      if (this.stopped || this.jobs.size >= MAX_IN_FLIGHT) break;
      if (this.reading.has(entry)) continue;
      this.pending.delete(entry);
      this.reading.add(entry);
      const generation = entry.generation;
      const job = this.read(entry, generation).catch(() => {
        if (this.current(entry, generation)) this.remove(entry);
      }).finally(() => {
        this.jobs.delete(job);
        this.reading.delete(entry);
        this.pump();
      });
      this.jobs.add(job);
    }
  }

  private async read(entry: Subscription, generation: number): Promise<void> {
    const threadId = entry.thread.threadId;
    const file = entry.file ?? await this.reader.findThreadPath!(threadId, true);
    if (!file || !this.current(entry, generation)) {
      if (this.current(entry, generation)) this.remove(entry);
      return;
    }
    const handle = await open(file, "r");
    try {
      const before = await handle.stat();
      if (!this.current(entry, generation)) return;
      if (!entry.initialized) {
        const head = Buffer.alloc(Math.min(before.size, 64 * 1024));
        await handle.read(head, 0, head.length, 0);
        if (!this.current(entry, generation)) return;
        const metadata = JSON.parse(head.toString("utf8").split("\n")[0] ?? "");
        if (metadata.type !== "session_meta" || metadata.payload?.id !== threadId) {
          this.remove(entry); return;
        }
        entry.file = file;
        entry.identity = identity(before);
        entry.watcher = watch(file, { persistent: false }, (event) => {
          if (event === "rename") this.remove(entry);
          else this.schedule(entry);
        });
        entry.watcher.on("error", () => this.remove(entry));
        entry.initialized = true;
      }
      if (entry.identity !== identity(before) || before.size < entry.offset) {
        this.remove(entry); return;
      }
      if (entry.baseline) {
        const latest = await this.reader.readLatestLifecycle(threadId);
        if (!this.current(entry, generation)) return;
        const after = await stat(file);
        if (signature(after) !== signature(before)) { this.schedule(entry); return; }
        entry.start = latest?.type === "task_started" && latest.turnId !== entry.ignoredTurn ? latest : null;
        if (entry.start && entry.awaitingStart) {
          entry.promptTurn = entry.start.turnId;
          entry.awaitingStart = false;
        }
        entry.latest = entry.start;
        entry.offset = before.size;
        const tail = Buffer.alloc(1);
        if (before.size) await handle.read(tail, 0, 1, before.size - 1);
        entry.partial = Buffer.alloc(0);
        entry.skipLine = before.size > 0 && tail[0] !== 10;
        entry.baseline = false;
        return;
      }
      const size = Math.min(before.size - entry.offset, READ_BATCH_BYTES);
      if (size > 0) {
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buffer, 0, size, entry.offset);
        if (!this.current(entry, generation)) return;
        this.reads++;
        this.bytesRead += bytesRead;
        entry.offset += bytesRead;
        this.consume(entry, buffer.subarray(0, bytesRead));
      }
      const after = await stat(file);
      if (!this.current(entry, generation)) return;
      if (signature(before) !== signature(after) || entry.offset < after.size) {
        this.schedule(entry); return;
      }
      const lifecycle = entry.latest;
      if (lifecycle?.status !== "idle" || !lifecycle.turnId || entry.start?.turnId !== lifecycle.turnId ||
        Date.parse(lifecycle.timestamp) < Date.parse(entry.thread.updatedAt)) return;
      this.hints++;
      await this.onHint({ threadId, generation, lifecycle, signature: signature(after) });
    } finally { await handle.close(); }
  }

  private consume(entry: Subscription, buffer: Buffer): void {
    let offset = 0;
    while (offset < buffer.length) {
      const end = buffer.indexOf(10, offset);
      const part = buffer.subarray(offset, end < 0 ? buffer.length : end);
      if (!entry.skipLine) {
        if (entry.partial.length + part.length <= MAX_LINE_BYTES) entry.partial = Buffer.concat([entry.partial, part]);
        else { entry.partial = Buffer.alloc(0); entry.skipLine = true; }
      }
      if (end < 0) break;
      if (!entry.skipLine) {
        const lifecycle = parseLatestLifecycle(entry.partial.toString("utf8"));
        if (lifecycle) {
          entry.latest = lifecycle;
          if (lifecycle.type === "task_started") {
            entry.start = lifecycle.turnId !== entry.ignoredTurn ? lifecycle : null;
            if (entry.start && entry.awaitingStart) {
              entry.promptTurn = entry.start.turnId;
              entry.awaitingStart = false;
            }
          }
        }
      }
      entry.partial = Buffer.alloc(0);
      entry.skipLine = false;
      offset = end + 1;
    }
  }
}

function identity(value: Stats): string { return `${value.dev}:${value.ino}`; }
function signature(value: Stats): string { return `${identity(value)}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`; }
