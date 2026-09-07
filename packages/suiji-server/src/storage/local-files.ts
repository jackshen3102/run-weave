import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, statfs, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { SUIJI_LIMITS } from "@runweave/shared/suiji";
import { ServiceError } from "../errors";
export interface AttachmentStore {
  stage(
    stream: Readable,
  ): Promise<{ key: string; path: string; byteSize: number; sha256: string }>;
  commit(key: string): Promise<void>;
  discard(key: string): Promise<void>;
  read(key: string): Readable;
}
export class LocalFileStore implements AttachmentStore {
  constructor(readonly root: string) {}
  async initialize() {
    await mkdir(path.join(this.root, "tmp"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.root, "objects"), {
      recursive: true,
      mode: 0o700,
    });
  }
  objectPath(key: string, temporary = false) {
    if (!/^[a-f0-9-]{36}$/.test(key))
      throw new Error("Invalid internal object key");
    return path.join(this.root, temporary ? "tmp" : "objects", key);
  }
  async stage(stream: Readable) {
    const key = randomUUID(),
      filePath = this.objectPath(key, true);
    const file = await open(filePath, "wx", 0o600);
    let byteSize = 0;
    const hash = createHash("sha256");
    try {
      for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
        const bytes = Buffer.from(chunk);
        byteSize += bytes.length;
        if (byteSize > SUIJI_LIMITS.attachmentBytes)
          throw new ServiceError(413, "PAYLOAD_TOO_LARGE", "附件超过 5 MiB");
        hash.update(bytes);
        await file.writeFile(bytes);
      }
      await file.sync();
      return { key, path: filePath, byteSize, sha256: hash.digest("hex") };
    } catch (error) {
      await rm(filePath, { force: true });
      throw error;
    } finally {
      await file.close();
    }
  }
  async commit(key: string) {
    await rename(this.objectPath(key, true), this.objectPath(key));
    const dir = await open(path.join(this.root, "objects"), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  discard(key: string) {
    return rm(this.objectPath(key, true), { force: true });
  }
  read(key: string) {
    return createReadStream(this.objectPath(key));
  }
  async statistics() {
    const disk = await statfs(this.root);
    return {
      freeBytes: disk.bavail * disk.bsize,
      objects: (await readdir(path.join(this.root, "objects"))).length,
      temporaryObjects: (await readdir(path.join(this.root, "tmp"))).length,
    };
  }
}
