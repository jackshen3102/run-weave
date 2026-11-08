import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertPrivateDirectory, readPrivateFile, syncDirectory } from "@runweave/config-node";

/** Only App Server events with an existing durable dedupeKey are replayable. */
export class EventOutbox {
  private draining: Promise<void> | undefined;
  readonly directory: string;
  incomplete = false;

  constructor(root: string) {
    this.directory = path.join(root, "events");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(this.directory);
  }

  accept(event: Record<string, unknown>): void {
    if (typeof event.dedupeKey !== "string" || !event.dedupeKey || event.dedupeKey.length > 1024)
      throw new Error("HOST_EVENT_ID_REQUIRED");
    const bytes = Buffer.from(JSON.stringify(event));
    if (bytes.length > 1024 * 1024) throw new Error("HOST_EVENT_TOO_LARGE");
    const id = createHash("sha256").update(event.dedupeKey).digest("hex");
    const file = path.join(this.directory, id + ".json");
    if (existsSync(file)) {
      if (readPrivateFile(file) !== bytes.toString()) throw new Error("HOST_EVENT_CONFLICT");
      return;
    }
    const size = readdirSync(this.directory).reduce((total, name) => total + statSync(path.join(this.directory, name)).size, 0);
    if (size + bytes.length > 16 * 1024 * 1024) { this.incomplete = true; throw new Error("HOST_OUTBOX_FULL"); }
    const temporary = file + ".tmp";
    const fd = openSync(temporary, "w", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    syncDirectory(this.directory);
  }

  drain(deliver: (body: string) => Promise<boolean>): Promise<void> {
    this.draining ??= (async () => {
      for (const name of readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const file = path.join(this.directory, name);
        const body = readPrivateFile(file);
        if (!await deliver(body)) break;
        unlinkSync(file);
        syncDirectory(this.directory);
      }
    })().finally(() => { this.draining = undefined; });
    return this.draining;
  }
}
