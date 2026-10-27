import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  historyUuid,
  validateHistoryObservation,
  type BrowserVisitObservation,
  type HistoryBrowser,
} from "@runweave/shared/browser-history";
import { privateDirectory, privateJson } from "./files.js";
export interface HistorySource {
  sourceId: string;
  browser: HistoryBrowser;
  profileLabel: string;
}
export class BrowserHistoryWriter {
  private readonly streamId = randomUUID();
  private readonly registered = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  pending = 0;
  lastStoredAt: string | null = null;
  error: string | null = null;
  constructor(readonly root: string) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(Error("WRITER_CLOSED"));
    this.pending++;
    const task = this.queue.then(operation);
    this.queue = task
      .catch((error) => {
        this.error = error instanceof Error ? error.message : "WRITE_FAILED";
      })
      .finally(() => {
        this.pending--;
      });
    return task;
  }
  private async register(source: HistorySource): Promise<void> {
    if (
      !historyUuid(source.sourceId) ||
      !["chrome", "edge", "runweave"].includes(source.browser) ||
      typeof source.profileLabel !== "string" ||
      !source.profileLabel.trim() ||
      source.profileLabel.length > 128
    )
      throw Error("INVALID_SOURCE");
    if (this.registered.has(source.sourceId)) return;
    await privateDirectory(this.root);
    await privateDirectory(path.join(this.root, "streams"));
    const fd = await open(
      path.join(this.root, "streams", this.streamId + ".jsonl"),
      "a",
      0o600,
    );
    await fd.close();
    await privateJson(
      path.join(this.root, "sources", source.sourceId, this.streamId + ".json"),
      {
        schemaVersion: 1,
        ...source,
        streamId: this.streamId,
        startedAt: new Date().toISOString(),
      },
    );
    this.registered.add(source.sourceId);
  }
  registerSource(source: HistorySource): Promise<void> {
    return this.serial(() => this.register(source));
  }
  append(rows: BrowserVisitObservation[]): Promise<void> {
    rows.forEach(validateHistoryObservation);
    // Freeze before entering the asynchronous queue; caller mutations cannot change ACKed bytes.
    const frozen = structuredClone(rows);
    return this.serial(async () => {
      for (const row of frozen) await this.register(row);
      const fd = await open(
        path.join(this.root, "streams", this.streamId + ".jsonl"),
        "a",
        0o600,
      );
      try {
        await fd.writeFile(
          frozen.map((row) => JSON.stringify(row) + "\n").join(""),
        );
        await fd.sync();
      } finally {
        await fd.close();
      }
      this.lastStoredAt = new Date().toISOString();
      this.error = null;
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
  }
}
