import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AppServerAgentKind,
  AppServerThreadDetail,
  AppServerThreadLifecycleEvent,
  AppServerThreadTurn,
} from "@runweave/shared/app-server-events";

const TRAE_AGENTS = new Set<AppServerAgentKind>(["trae", "traecli", "traex"]);
const KNOWN_CONTENT_EVENT_TYPES = new Set([
  "agent_reasoning_raw_content",
  "context_compacted",
  "message",
  "reasoning",
  "tool_call",
  "tool_result",
  "user_message",
]);

interface JsonlRecord {
  type?: unknown;
  timestamp?: unknown;
  payload?: unknown;
}

export class TraeThreadLifecycleReader {
  private readonly sessionsRoot: string;
  private readonly threadPaths = new Map<string, string>();

  constructor(sessionsRoot?: string) {
    this.sessionsRoot = path.resolve(
      sessionsRoot ??
        process.env.RUNWEAVE_TRAE_SESSIONS_DIR ??
        path.join(os.homedir(), ".trae", "cli", "sessions"),
    );
  }

  supports(provider: AppServerAgentKind): boolean {
    return TRAE_AGENTS.has(provider);
  }

  async readThread(
    threadId: string,
    provider: AppServerAgentKind,
  ): Promise<AppServerThreadDetail | null> {
    if (!this.supports(provider)) {
      return null;
    }
    const filePath = await this.findThreadPath(threadId);
    if (!filePath) {
      return null;
    }
    return this.readThreadFile(filePath, threadId, provider);
  }

  shutdown(): void {
    this.threadPaths.clear();
  }

  private async findThreadPath(threadId: string): Promise<string | null> {
    const cached = this.threadPaths.get(threadId);
    if (cached) {
      return cached;
    }
    const candidates = await listJsonlFiles(this.sessionsRoot);
    for (const candidate of candidates) {
      const filenameThreadId = readThreadIdFromFilename(candidate);
      if (filenameThreadId) {
        this.threadPaths.set(filenameThreadId, candidate);
      }
    }
    const filenameMatch = this.threadPaths.get(threadId);
    if (filenameMatch) {
      return filenameMatch;
    }
    for (const candidate of candidates) {
      const sessionId = await readSessionId(candidate);
      if (sessionId === threadId) {
        this.threadPaths.set(threadId, candidate);
        return candidate;
      }
    }
    return null;
  }

  private async readThreadFile(
    filePath: string,
    expectedThreadId: string,
    provider: AppServerAgentKind,
  ): Promise<AppServerThreadDetail | null> {
    const records = parseJsonl(await readFile(filePath, "utf8"));
    const sessionId = readSessionIdFromRecords(records);
    if (sessionId !== expectedThreadId) {
      this.threadPaths.delete(expectedThreadId);
      return null;
    }

    const lifecycle: AppServerThreadLifecycleEvent[] = [];
    const turns = new Map<string, AppServerThreadTurn>();
    let preview: string | null = null;
    let status: AppServerThreadDetail["status"] = "unknown";

    records.forEach((record, index) => {
      const payload = readRecord(record.payload);
      const type = readString(payload.type);
      if (!type || !isLifecycleEventType(type)) {
        return;
      }
      const timestamp = readString(record.timestamp);
      const turnId = readString(payload.turn_id) ?? readString(payload.turnId);
      const event: AppServerThreadLifecycleEvent = {
        cursor: String(index + 1),
        type,
        timestamp,
        turnId,
        raw: payload,
      };
      lifecycle.push(event);

      if (type === "task_started") {
        status = "running";
        if (turnId) {
          turns.set(turnId, {
            turnId,
            status: "running",
            startedAt: readString(payload.started_at) ?? timestamp,
            completedAt: null,
            preview: null,
          });
        }
        return;
      }
      if (type === "task_complete") {
        status = "idle";
        const turnPreview = normalizePreview(payload.last_agent_message);
        preview = turnPreview ?? preview;
        if (turnId) {
          const previous = turns.get(turnId);
          turns.set(turnId, {
            turnId,
            status: "completed",
            startedAt: previous?.startedAt ?? null,
            completedAt: readString(payload.completed_at) ?? timestamp,
            preview: turnPreview,
          });
        }
        return;
      }
      if (type === "turn_aborted") {
        status = "interrupted";
        if (turnId) {
          const previous = turns.get(turnId);
          turns.set(turnId, {
            turnId,
            status: "interrupted",
            startedAt: previous?.startedAt ?? null,
            completedAt: readString(payload.completed_at) ?? timestamp,
            preview: previous?.preview ?? null,
          });
        }
      }
    });

    return {
      provider,
      id: expectedThreadId,
      status,
      preview,
      turns: [...turns.values()],
      lifecycle,
      lastLifecycleCursor: lifecycle.at(-1)?.cursor ?? null,
      sourcePath: filePath,
    };
  }
}

function readThreadIdFromFilename(filePath: string): string | null {
  return (
    path
      .basename(filePath)
      .match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1] ??
    null
  );
}

function isLifecycleEventType(type: string): boolean {
  return (
    type === "task_started" ||
    type === "task_complete" ||
    type === "turn_aborted" ||
    !KNOWN_CONTENT_EVENT_TYPES.has(type)
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

async function readSessionId(filePath: string): Promise<string | null> {
  try {
    return readSessionIdFromRecords(parseJsonl(await readFile(filePath, "utf8")));
  } catch {
    return null;
  }
}

function readSessionIdFromRecords(records: JsonlRecord[]): string | null {
  for (const record of records) {
    if (record.type !== "session_meta") {
      continue;
    }
    return readString(readRecord(record.payload).id);
  }
  return null;
}

function parseJsonl(value: string): JsonlRecord[] {
  const records: JsonlRecord[] = [];
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push(parsed as JsonlRecord);
      }
    } catch {
      // A partial final JSONL line is retried on the next reconciliation pass.
    }
  }
  return records;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePreview(value: unknown): string | null {
  const preview = readString(value);
  if (!preview) {
    return null;
  }
  return preview.length > 8_000 ? `${preview.slice(0, 8_000)}…` : preview;
}
