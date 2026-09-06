import { open, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROLLOUT_TAIL_BYTES = 1024 * 1024;
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
}

export interface CodexRolloutLifecycleReaderLike {
  readLatestLifecycle(threadId: string): Promise<CodexRolloutLifecycle | null>;
  shutdown(): void;
}

export class CodexRolloutLifecycleReader implements CodexRolloutLifecycleReaderLike {
  private readonly sessionsRoots: string[];
  private readonly threadPaths = new Map<string, string>();

  constructor(sessionsRoot?: string) {
    const configuredRoot =
      sessionsRoot ?? process.env.RUNWEAVE_CODEX_SESSIONS_DIR;
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
      return parseLatestLifecycle(await readFileTail(filePath));
    } catch {
      this.threadPaths.delete(threadId);
      return null;
    }
  }

  shutdown(): void {
    this.threadPaths.clear();
  }

  private async findThreadPath(threadId: string): Promise<string | null> {
    const cached = this.threadPaths.get(threadId);
    if (cached) {
      return cached;
    }
    for (const root of this.sessionsRoots) {
      for (const candidate of await listJsonlFiles(root)) {
        const candidateThreadId = readThreadIdFromFilename(candidate);
        if (candidateThreadId) {
          this.threadPaths.set(candidateThreadId, candidate);
        }
        const filename = path.basename(candidate);
        if (
          filename === `${threadId}.jsonl` ||
          filename.endsWith(`-${threadId}.jsonl`)
        ) {
          this.threadPaths.set(threadId, candidate);
          return candidate;
        }
      }
      const match = this.threadPaths.get(threadId);
      if (match) {
        return match;
      }
    }
    return null;
  }
}

async function readFileTail(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - ROLLOUT_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const value = buffer.subarray(0, bytesRead).toString("utf8");
    if (start === 0) {
      return value;
    }
    const firstNewline = value.indexOf("\n");
    return firstNewline === -1 ? "" : value.slice(firstNewline + 1);
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
