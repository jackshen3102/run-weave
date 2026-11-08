import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertPrivateDirectory, readPrivateFile, syncDirectory } from "@runweave/config-node";

/** Only App Server events with an existing durable dedupeKey are replayable. */
export class EventOutbox {
  private draining: Promise<void> | undefined;
  readonly directory: string;
  incomplete = false;
  private sequence = Date.now() * 1000;

  constructor(root: string) {
    this.directory = path.join(root, "events");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(this.directory);
    this.incomplete = existsSync(path.join(this.directory, "incomplete"));
    for (const name of readdirSync(this.directory)) {
      const number = Number(name.split("-")[0]);
      if (Number.isSafeInteger(number)) this.sequence = Math.max(this.sequence, number);
    }
  }

  accept(event: Record<string, unknown>): void {
    if (typeof event.dedupeKey !== "string" || !event.dedupeKey || event.dedupeKey.length > 1024)
      throw new Error("HOST_EVENT_ID_REQUIRED");
    const bytes = Buffer.from(JSON.stringify(event));
    if (bytes.length > 1024 * 1024) throw new Error("HOST_EVENT_TOO_LARGE");
    const id = createHash("sha256").update(event.dedupeKey).digest("hex");
    const entries = readdirSync(this.directory);
    const previous = entries.find(name => name.endsWith(`-${id}.json`));
    if (previous) {
      if (readPrivateFile(path.join(this.directory, previous)) !== bytes.toString()) throw new Error("HOST_EVENT_CONFLICT");
      return;
    }
    const size = entries.reduce((total, name) => total + statSync(path.join(this.directory, name)).size, 0);
    if (size + bytes.length > 16 * 1024 * 1024 || entries.length >= 4096) { this.markIncomplete(); throw new Error("HOST_OUTBOX_FULL"); }
    const file = path.join(this.directory, `${String(++this.sequence).padStart(16, "0")}-${id}.json`);
    const temporary = file + ".tmp";
    const fd = openSync(temporary, "w", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    syncDirectory(this.directory);
  }

  private markIncomplete(): void {
    this.incomplete = true;
    const fd = openSync(path.join(this.directory, "incomplete"), "w", 0o600);
    try { writeFileSync(fd, "Event delivery incomplete; inspect retained outbox records.\n"); fsyncSync(fd); } finally { closeSync(fd); }
  }

  drain(deliver: (body: string) => Promise<boolean | "rejected">): Promise<void> {
    this.draining ??= (async () => {
      for (const name of readdirSync(this.directory).filter(name => /^\d{16}-[a-f0-9]{64}\.json$/.test(name)).sort()) {
        const file = path.join(this.directory, name);
        const body = readPrivateFile(file);
        const result = await deliver(body);
        if (!result) break;
        if (result === "rejected") { renameSync(file, file + ".rejected"); this.markIncomplete(); }
        else unlinkSync(file);
        syncDirectory(this.directory);
      }
    })().finally(() => { this.draining = undefined; });
    return this.draining;
  }
}
