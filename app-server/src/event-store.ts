import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AppServerEventEnvelope,
  CreateAppServerEventRequest,
} from "@runweave/shared";

export interface ListEventsOptions {
  after: string | null;
  kinds: string[];
  limit: number;
}

export class AppServerEventStore {
  private events: AppServerEventEnvelope[] = [];
  private nextId = 1;

  constructor(private readonly eventLogPath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.eventLogPath), { recursive: true });
    try {
      const content = await readFile(this.eventLogPath, "utf8");
      this.events = content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown)
        .filter(isEventEnvelope);
      this.nextId =
        this.events.reduce(
          (max, event) => Math.max(max, Number(event.id) || 0),
          0,
        ) + 1;
    } catch {
      this.events = [];
      this.nextId = 1;
      await writeFile(this.eventLogPath, "", { flag: "a" });
    }
  }

  async append(
    input: CreateAppServerEventRequest,
  ): Promise<{ event: AppServerEventEnvelope; created: boolean }> {
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
    this.nextId += 1;
    this.events.push(event);
    await writeFile(this.eventLogPath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      flag: "a",
    });
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
