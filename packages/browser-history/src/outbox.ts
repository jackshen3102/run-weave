import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  lstatSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  HISTORY_QUEUE_BYTES,
  historyObservationKey,
  validateHistoryObservation,
  type BrowserVisitObservation,
} from "@runweave/shared/browser-history";
import { BrowserHistoryWriter, type HistorySource } from "./writer.js";

/** Durable, bounded observations. A lost acknowledgement replays the original identity. */
export class BrowserHistoryOutbox {
  private readonly rows = new Map<
    string,
    { row: BrowserVisitObservation; bytes: number; file: string }
  >();
  private writer: BrowserHistoryWriter;
  private draining: Promise<void> | undefined;
  private closed = false;
  private bytes = 2;
  error: string | null = null;
  lastStoredAt: string | null = null;
  constructor(
    readonly root: string,
    readonly directory: string,
    readonly source: HistorySource,
  ) {
    this.writer = new BrowserHistoryWriter(root);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (
      !lstatSync(directory).isDirectory() ||
      lstatSync(directory).isSymbolicLink()
    )
      throw Error("UNSAFE_OUTBOX_DIRECTORY");
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json") || name === "receipt.json") continue;
      if (!/^[a-f0-9-]{36}\.[1-9][0-9]*\.json$/.test(name))
        throw Error("INVALID_OUTBOX_FILE");
      const file = path.join(directory, name);
      if (
        !lstatSync(file).isFile() ||
        lstatSync(file).isSymbolicLink() ||
        statSync(file).size > 8192
      )
        throw Error("INVALID_OUTBOX_FILE");
      const row: unknown = JSON.parse(readFileSync(file, "utf8"));
      validateHistoryObservation(row);
      if (
        row.sourceId !== source.sourceId ||
        row.browser !== source.browser ||
        name !== `${row.visitId}.${row.revision}.json`
      )
        throw Error("OUTBOX_SOURCE_MISMATCH");
      const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
      this.rows.set(historyObservationKey(row), { row, bytes, file });
      this.bytes += bytes;
    }
    if (this.bytes > HISTORY_QUEUE_BYTES) throw Error("OUTBOX_TOO_LARGE");
    try {
      const receipt = JSON.parse(
        readFileSync(path.join(directory, "receipt.json"), "utf8"),
      );
      if (
        receipt.sourceId !== source.sourceId ||
        typeof receipt.lastStoredAt !== "string"
      )
        throw Error("INVALID_OUTBOX_RECEIPT");
      this.lastStoredAt = receipt.lastStoredAt;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  get pending() {
    return this.rows.size;
  }
  private store(file: string, value: unknown) {
    const temporary = `${file}.${randomUUID()}.tmp`,
      fd = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, JSON.stringify(value));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, file);
    } catch (e) {
      try {
        unlinkSync(temporary);
      } catch {
        /* Preserve the original write error. */
      }
      throw e;
    }
  }
  enqueue(row: BrowserVisitObservation): void {
    if (this.closed) throw Error("OUTBOX_CLOSED");
    validateHistoryObservation(row);
    if (
      row.sourceId !== this.source.sourceId ||
      row.browser !== this.source.browser
    )
      throw Error("OUTBOX_SOURCE_MISMATCH");
    const key = historyObservationKey(row),
      bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (this.rows.has(key)) return;
    if (this.bytes + bytes > HISTORY_QUEUE_BYTES)
      throw Error(
        "待保存数据达到 4 MiB，已暂停新采集；旧记录保留，请先重试保存。",
      );
    const file = path.join(
      this.directory,
      `${row.visitId}.${row.revision}.json`,
    );
    this.store(file, row);
    this.rows.set(key, { row: structuredClone(row), bytes, file });
    this.bytes += bytes;
    void this.flush();
  }
  flush(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.drain()
      .catch(async (e) => {
        this.error = String(e);
        await this.writer.close();
        this.writer = new BrowserHistoryWriter(this.root);
      })
      .finally(() => {
        this.draining = undefined;
      });
    return this.draining;
  }
  private async drain() {
    if (!this.rows.size) return;
    await this.writer.registerSource(this.source);
    while (this.rows.size) {
      const batch = [...this.rows.entries()].slice(0, 64);
      await this.writer.append(batch.map(([, item]) => item.row));
      const storedAt = this.writer.lastStoredAt!;
      this.store(path.join(this.directory, "receipt.json"), {
        sourceId: this.source.sourceId,
        lastStoredAt: storedAt,
      });
      for (const [key, item] of batch) {
        unlinkSync(item.file);
        this.rows.delete(key);
        this.bytes -= item.bytes;
      }
      this.lastStoredAt = storedAt;
    }
    this.error = null;
  }
  async close() {
    this.closed = true;
    await this.flush();
    await this.writer.close();
  }
}
