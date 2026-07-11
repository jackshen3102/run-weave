import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AppServerEventEnvelope,
  CreateAppServerEventRequest,
} from "@runweave/shared";

const DEFAULT_EVENT_RETENTION_DAYS = 7;
const DEFAULT_RETENTION_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ListEventsOptions {
  after: string | null;
  kinds: string[];
  limit: number;
}

export interface AppServerEventStoreOptions {
  retentionDays?: number;
  pruneIntervalMs?: number;
}

export class AppServerEventStore {
  private events: AppServerEventEnvelope[] = [];
  private nextId = 1;
  private appendQueue: Promise<void> = Promise.resolve();
  private lastPrunedAtMs = 0;
  private readonly retentionMs: number;
  private readonly pruneIntervalMs: number;

  constructor(
    private readonly eventLogPath: string,
    options: AppServerEventStoreOptions = {},
  ) {
    this.retentionMs =
      Math.max(options.retentionDays ?? DEFAULT_EVENT_RETENTION_DAYS, 0) *
      DAY_MS;
    this.pruneIntervalMs = Math.max(
      options.pruneIntervalMs ?? DEFAULT_RETENTION_PRUNE_INTERVAL_MS,
      0,
    );
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.eventLogPath), { recursive: true });
    let content = "";
    try {
      content = await readFile(this.eventLogPath, "utf8");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
      this.events = [];
      this.nextId = 1;
      await writeFile(this.eventLogPath, "", { flag: "a" });
      this.lastPrunedAtMs = Date.now();
      return;
    }

    const lines = content.split(/\r?\n/).filter(Boolean);
    const loadedEvents = lines
      .map((line) => parseEventLine(line))
      .filter(isEventEnvelope);
    this.nextId = getNextEventId(loadedEvents);
    this.events = filterRetainedEvents(loadedEvents, this.getCutoffTimeMs());
    if (this.events.length !== lines.length) {
      await this.rewriteEventLog();
    }
    this.lastPrunedAtMs = Date.now();
  }

  append(
    input: CreateAppServerEventRequest,
  ): Promise<{ event: AppServerEventEnvelope; created: boolean }> {
    const operation = this.appendQueue.then(() => this.appendSerial(input));
    this.appendQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async appendSerial(
    input: CreateAppServerEventRequest,
  ): Promise<{ event: AppServerEventEnvelope; created: boolean }> {
    await this.pruneExpiredEventsIfDue();
    const dedupeKey = input.dedupeKey?.trim() || null;
    if (dedupeKey) {
      const existing = this.events.find(
        (event) => event.dedupeKey === dedupeKey,
      );
      if (existing) {
        return { event: existing, created: false };
      }
    }

    const event: AppServerEventEnvelope = {
      id: String(this.nextId),
      version: 1,
      kind: input.kind,
      source: input.source,
      ...(input.scope ? { scope: input.scope } : {}),
      dedupeKey,
      correlationId: input.correlationId?.trim() || null,
      payload: input.payload,
      createdAt: new Date().toISOString(),
    };
    await writeFile(this.eventLogPath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      flag: "a",
    });
    this.nextId += 1;
    this.events.push(event);
    return { event, created: true };
  }

  listAfter(options: ListEventsOptions): AppServerEventEnvelope[] {
    const after = options.after === null ? 0 : Number(options.after);
    const kinds = new Set(options.kinds);
    return this.events
      .filter((event) => Number(event.id) > after)
      .filter((event) => kinds.size === 0 || kinds.has(event.kind))
      .slice(0, options.limit);
  }

  getLatestId(): string | null {
    return this.events[this.events.length - 1]?.id ?? null;
  }

  listAll(): AppServerEventEnvelope[] {
    return [...this.events];
  }

  private getCutoffTimeMs(): number {
    if (this.retentionMs <= 0) {
      return Date.now();
    }
    return Date.now() - this.retentionMs;
  }

  private async pruneExpiredEventsIfDue(): Promise<void> {
    if (
      this.pruneIntervalMs > 0 &&
      Date.now() - this.lastPrunedAtMs < this.pruneIntervalMs
    ) {
      return;
    }
    const retainedEvents = filterRetainedEvents(
      this.events,
      this.getCutoffTimeMs(),
    );
    this.lastPrunedAtMs = Date.now();
    if (retainedEvents.length === this.events.length) {
      return;
    }
    this.events = retainedEvents;
    await this.rewriteEventLog();
  }

  private async rewriteEventLog(): Promise<void> {
    await writeFile(
      this.eventLogPath,
      this.events.map((event) => JSON.stringify(event)).join("\n") +
        (this.events.length > 0 ? "\n" : ""),
      { encoding: "utf8" },
    );
  }
}

function getNextEventId(events: AppServerEventEnvelope[]): number {
  return (
    events.reduce((max, event) => Math.max(max, Number(event.id) || 0), 0) + 1
  );
}

function parseEventLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

function filterRetainedEvents(
  events: AppServerEventEnvelope[],
  cutoffTimeMs: number,
): AppServerEventEnvelope[] {
  return events.filter((event) => {
    const createdAtTimeMs = Date.parse(event.createdAt);
    return !Number.isFinite(createdAtTimeMs) || createdAtTimeMs >= cutoffTimeMs;
  });
}

function isEventEnvelope(value: unknown): value is AppServerEventEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.version === 1 &&
    typeof record.kind === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.source === "object" &&
    record.source !== null &&
    "payload" in record
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
