import { settingText } from "@runweave/config-node";
import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROLLOUT_TAIL_BYTES = 1024 * 1024;
const ROLLOUT_LOOKBACK_BYTES = 64 * ROLLOUT_TAIL_BYTES;
const TERMINAL_LIFECYCLE_TYPES = new Set([
  "task_started",
  "task_complete",
  "turn_aborted",
]);

interface RolloutRecord {
  ordinal?: unknown;
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

export interface CodexRolloutLifecycle {
  status: "idle" | "running";
  type: "task_started" | "task_complete" | "turn_aborted";
  cursor: string;
  timestamp: string;
  turnId: string | null;
  error?: { code: string; message: string };
}

export interface CodexRolloutLifecycleReaderLike {
  readLatestLifecycle(threadId: string): Promise<CodexRolloutLifecycle | null>;
  shutdown(): void;
}

export class CodexRolloutLifecycleReader implements CodexRolloutLifecycleReaderLike {
  private readonly sessionsRoots: string[];
  private readonly threadPaths = new Map<string, string>();
  private readonly snapshots = new Map<string, { signature: string; lifecycle: CodexRolloutLifecycle | null }>();
  private indexPromise: Promise<void> | null = null;
  private indexedAt = 0;

  constructor(sessionsRoot?: string) {
    const configuredRoot =
      sessionsRoot ?? settingText("agents.codex.sessionsDirectory");
    this.sessionsRoots = configuredRoot
      ? [path.resolve(configuredRoot)]
      : [
          path.join(os.homedir(), ".codex", "sessions"),
          path.join(os.homedir(), ".codex", "archived_sessions"),
        ];
  }

  async readLatestLifecycle(
    threadId: string,
  ): Promise<CodexRolloutLifecycle | null> {
    const filePath = await this.findThreadPath(threadId);
    if (!filePath) {
      return null;
    }
    try {
      const previous = this.snapshots.get(threadId);
      const snapshot = await readFileLifecycle(filePath, previous);
      this.snapshots.delete(threadId);
      this.snapshots.set(threadId, snapshot);
      if (this.snapshots.size > 128) this.snapshots.delete(this.snapshots.keys().next().value!);
      return snapshot.lifecycle;
    } catch {
      this.threadPaths.delete(threadId);
      this.snapshots.delete(threadId);
      return null;
    }
  }

  shutdown(): void {
    this.threadPaths.clear();
    this.snapshots.clear();
  }

  async findThreadPath(threadId: string): Promise<string | null> {
    const cached = this.threadPaths.get(threadId);
    if (cached) {
      return cached;
    }
    // Coalesce cold/missing lookups: a homepage batch must not rescan the tree per thread.
    if (!this.indexPromise && Date.now() - this.indexedAt >= 30_000) {
      this.indexPromise = (async () => {
        for (const root of this.sessionsRoots) {
          for (const candidate of await listJsonlFiles(root)) {
            const id = readThreadIdFromFilename(candidate) ?? path.basename(candidate, ".jsonl");
            if (!this.threadPaths.has(id)) this.threadPaths.set(id, candidate);
          }
        }
        this.indexedAt = Date.now();
      })().finally(() => { this.indexPromise = null; });
    }
    await this.indexPromise;
    return this.threadPaths.get(threadId) ?? [...this.threadPaths]
      .find(([id]) => id.endsWith(`-${threadId}`))?.[1] ?? null;
  }
}

async function readFileLifecycle(
  filePath: string,
  previous?: { signature: string; lifecycle: CodexRolloutLifecycle | null },
): Promise<{ signature: string; lifecycle: CodexRolloutLifecycle | null }> {
  const handle = await open(filePath, "r");
  try {
    const { size, dev, ino, mtimeMs, ctimeMs } = await handle.stat();
    const signature = `${filePath}:${dev}:${ino}:${size}:${mtimeMs}:${ctimeMs}`;
    if (signature === previous?.signature) return previous;
    const floor = Math.max(0, size - ROLLOUT_LOOKBACK_BYTES);
    let end = size;
    let suffix = Buffer.alloc(0);
    let lifecycle: CodexRolloutLifecycle | null = null;
    // Long turns can append megabytes without another lifecycle record. Search
    // backwards in bounded chunks rather than mistaking a quiet tail for no turn.
    while (end > floor && !lifecycle) {
      const start = Math.max(floor, end - ROLLOUT_TAIL_BYTES);
      const buffer = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      if (bytesRead !== buffer.length) return { signature, lifecycle: null };
      const value = Buffer.concat([buffer, suffix]);
      const boundary = start > 0 ? value.indexOf(10) : -1;
      const complete = start === 0 ? value : boundary < 0 ? Buffer.alloc(0) : value.subarray(boundary + 1);
      lifecycle = parseLatestLifecycle(complete.toString("utf8"));
      // Lifecycle records fit in one chunk; discard oversized tool/image lines.
      suffix = boundary >= 0 && boundary < ROLLOUT_TAIL_BYTES
        ? Buffer.from(value.subarray(0, boundary + 1)) : Buffer.alloc(0);
      end = start;
    }
    const current = await stat(filePath);
    if (current.dev !== dev || current.ino !== ino || current.size !== size ||
        current.mtimeMs !== mtimeMs || current.ctimeMs !== ctimeMs)
      return { signature, lifecycle: null };
    return { signature, lifecycle };
  } finally {
    await handle.close();
  }
}

function parseLatestLifecycle(value: string): CodexRolloutLifecycle | null {
  let latest: CodexRolloutLifecycle | null = null;
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let record: RolloutRecord;
    try {
      record = JSON.parse(line) as RolloutRecord;
    } catch {
      continue;
    }
    if (record.type !== "event_msg") {
      continue;
    }
    const payload = readRecord(record.payload);
    const type = readString(payload.type);
    const timestamp = readString(record.timestamp);
    if (
      !type ||
      !timestamp ||
      !Number.isFinite(Date.parse(timestamp)) ||
      !TERMINAL_LIFECYCLE_TYPES.has(type)
    ) {
      continue;
    }
    const lifecycleType = type as CodexRolloutLifecycle["type"];
    const ordinal =
      typeof record.ordinal === "number" || typeof record.ordinal === "string"
        ? String(record.ordinal)
        : `${timestamp}:${lifecycleType}`;
    latest = {
      status: lifecycleType === "task_started" ? "running" : "idle",
      type: lifecycleType,
      cursor: `rollout:${ordinal}`,
      timestamp,
      turnId: readString(payload.turn_id) ?? readString(payload.turnId),
      ...(payload.error && typeof payload.error === "object" ? { error: { code: readString(readRecord(payload.error).codex_error_info) ?? "agent_error", message: readString(readRecord(payload.error).message) ?? "Agent 任务因错误结束" } } : {}),
    };
  }
  return latest;
}

function readThreadIdFromFilename(filePath: string): string | null {
  return (
    path
      .basename(filePath)
      .match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1] ??
    null
  );
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  };
  await visit(root);
  return files;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
