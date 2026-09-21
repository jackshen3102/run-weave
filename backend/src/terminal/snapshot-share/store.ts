import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, link, mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { SNAPSHOT_MAX_TEXT_BYTES, type PublishTerminalSnapshotResponse, type TerminalSnapshotShareAccess } from "@runweave/shared/terminal/snapshot-share";
import { logger } from "../../logging/index";
import { TerminalSnapshotShareError } from "./errors";

export { SNAPSHOT_MAX_TEXT_BYTES };
const MAX_STORAGE_BYTES = 100 * 1024 * 1024;
const MAX_RECORDS = 100;
const LIFETIME_MS = 86_400_000;
const SIGNING_KEY_NAME = ".signing-key";
const RECORD_NAME_PATTERN = /^[a-f0-9]{64}\.json$/;
const TEMP_NAME_PATTERN = /^[a-f0-9-]{36}\.tmp$/;
// JSON escaping can expand one input byte to six bytes.
const MAX_RECORD_BYTES = SNAPSHOT_MAX_TEXT_BYTES * 6 + 4096;

const recordSchema = z.object({
  version: z.literal(1),
  snapshotId: z.string().uuid(),
  title: z.string().max(240),
  text: z.string(),
  lineCount: z.number().int().positive(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export type TerminalSnapshotRecord = z.infer<typeof recordSchema>;

function countLines(text: string): number {
  let count = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count += 1;
  return count;
}

function recordName(snapshotId: string): string {
  return `${createHash("sha256").update(snapshotId).digest("hex")}.json`;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class TerminalSnapshotShareStore {
  private queue: Promise<unknown> = Promise.resolve();
  private signingKey: Buffer | null = null;

  constructor(private readonly directory: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await syncDirectory(path.dirname(this.directory));
    await this.initializeSigningKey();
    await this.cleanup();
    await syncDirectory(this.directory);
  }

  private async initializeSigningKey(): Promise<void> {
    const keyPath = path.join(this.directory, SIGNING_KEY_NAME);
    try {
      this.signingKey = await readFile(keyPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const temporaryPath = path.join(this.directory, `${randomUUID()}.tmp`);
      try {
        const file = await open(temporaryPath, "wx", 0o600);
        try {
          await file.writeFile(randomBytes(32));
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          await link(temporaryPath, keyPath);
        } catch (publishError) {
          if ((publishError as NodeJS.ErrnoException).code !== "EEXIST") throw publishError;
        }
        this.signingKey = await readFile(keyPath);
      } finally {
        await unlink(temporaryPath).catch((cleanupError: unknown) => { if (!isMissing(cleanupError)) throw cleanupError; });
      }
    }
    // Never silently replace a damaged key: that would invalidate all existing links.
    if (this.signingKey.length !== 32) throw new Error("Invalid snapshot signing key");
    await chmod(keyPath, 0o600);
  }

  private signature(snapshotId: string, expires: number): Buffer {
    if (!this.signingKey) throw new Error("Snapshot signing key unavailable");
    return Buffer.from(createHmac("sha256", this.signingKey)
      .update(`runweave:terminal-snapshot:read:v1\n${snapshotId}\n${expires}`)
      .digest("base64url"));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async readRecord(filePath: string): Promise<TerminalSnapshotRecord | null> {
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size > MAX_RECORD_BYTES) throw new Error("Invalid size");
      const record = recordSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
      const createdAt = Date.parse(record.createdAt);
      const expiresAt = Date.parse(record.expiresAt);
      if (
        createdAt > Date.now() ||
        expiresAt - createdAt > LIFETIME_MS ||
        Buffer.byteLength(record.text, "utf8") > SNAPSHOT_MAX_TEXT_BYTES ||
        record.lineCount !== countLines(record.text)
      ) throw new Error("Invalid record");
      return record;
    } catch (error) {
      if (!isMissing(error)) {
        // Never log the parser error, filename, token, or partial record.
        logger.warn("terminal.snapshot-share.record-unreadable", { code: "INVALID_RECORD" });
      }
      return null;
    }
  }

  async read(access: TerminalSnapshotShareAccess): Promise<TerminalSnapshotRecord | null> {
    if (!Number.isSafeInteger(access.expires) || Date.now() >= access.expires) return null;
    const expected = this.signature(access.snapshotId, access.expires);
    const supplied = Buffer.from(access.signature);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    const record = await this.readRecord(path.join(this.directory, recordName(access.snapshotId)));
    return record && record.snapshotId === access.snapshotId &&
      Date.parse(record.expiresAt) === access.expires && Date.now() < access.expires ? record : null;
  }

  private async scan(): Promise<{ bytes: number; count: number }> {
    let bytes = 0;
    let count = 0;
    for (const name of await readdir(this.directory)) {
      const filePath = path.join(this.directory, name);
      if (TEMP_NAME_PATTERN.test(name)) {
        await unlink(filePath).catch((error: unknown) => { if (!isMissing(error)) throw error; });
        continue;
      }
      if (!RECORD_NAME_PATTERN.test(name)) continue;
      const record = await this.readRecord(filePath);
      if (record && Date.now() >= Date.parse(record.expiresAt)) {
        await unlink(filePath).catch((error: unknown) => { if (!isMissing(error)) throw error; });
        continue;
      }
      // Corrupt records remain unreadable but still consume quota.
      try {
        bytes += (await stat(filePath)).size;
        count += 1;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return { bytes, count };
  }

  cleanup(): Promise<void> {
    return this.serialize(async () => { await this.scan(); });
  }

  save(title: string, text: string): Promise<PublishTerminalSnapshotResponse> {
    return this.serialize(async () => {
      if (Buffer.byteLength(text, "utf8") > SNAPSHOT_MAX_TEXT_BYTES) {
        throw new TerminalSnapshotShareError("SNAPSHOT_TOO_LARGE");
      }
      const quota = await this.scan();
      const now = Date.now();
      const record: TerminalSnapshotRecord = {
        version: 1,
        snapshotId: randomUUID(),
        title,
        text,
        lineCount: countLines(text),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + LIFETIME_MS).toISOString(),
      };
      const expires = Date.parse(record.expiresAt);
      const signature = this.signature(record.snapshotId, expires).toString();
      const serialized = JSON.stringify(record);
      if (quota.count >= MAX_RECORDS || quota.bytes + Buffer.byteLength(serialized) > MAX_STORAGE_BYTES) {
        throw new TerminalSnapshotShareError("SNAPSHOT_STORAGE_FULL");
      }
      const temporaryPath = path.join(this.directory, `${record.snapshotId}.tmp`);
      try {
        const file = await open(temporaryPath, "wx", 0o600);
        try {
          await file.writeFile(serialized, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        // Atomic, exclusive publication: never overwrite an existing snapshot.
        await link(temporaryPath, path.join(this.directory, recordName(record.snapshotId)));
      } finally {
        await unlink(temporaryPath).catch((error: unknown) => { if (!isMissing(error)) throw error; });
      }
      // File fsync alone does not persist the published filename. Flush the
      // directory after publication and temporary-link removal before success.
      await syncDirectory(this.directory);
      return {
        sharePath: `/share/terminal/${record.snapshotId}?expires=${expires}&signature=${signature}`,
        title: record.title,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        lineCount: record.lineCount,
      };
    });
  }
}
