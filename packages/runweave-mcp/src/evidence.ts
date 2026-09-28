import { createHash, randomUUID } from "node:crypto";
import { fileVersion, readChunk, gitIdentity } from "./files.js";

interface Reference {
  title: string;
  read: () => Promise<{ text: string; metadata: Record<string, unknown> }>;
}

export class Evidence {
  private references = new Map<string, Reference>();
  constructor(readonly baseUrl: string) {}

  add(title: string, read: Reference["read"]) {
    // References are process-local and bounded; originals stay in their owners.
    if (this.references.size >= 4096)
      this.references.delete(this.references.keys().next().value!);
    const id = randomUUID();
    this.references.set(id, { title, read });
    return { id, title, url: `${this.baseUrl}/evidence/${id}` };
  }

  note(title: string, value: unknown) {
    const text = JSON.stringify(value, null, 2);
    const observedAt = new Date().toISOString();
    return this.add(title, async () => ({
      text,
      metadata: { observedAt, kind: "query_receipt", live: false },
    }));
  }

  async file(
    file: string,
    offset = 0,
    expectedVersion?: string,
  ): Promise<{ id: string; title: string; url: string }> {
    const version = expectedVersion ?? (await fileVersion(file));
    return this.add(`${file} @ byte ${offset}`, async () => {
      if ((await fileVersion(file)) !== version)
        throw new Error("source_changed: search/read the file again");
      const [chunk, git] = await Promise.all([
        readChunk(file, offset),
        gitIdentity(file),
      ]);
      if ((await fileVersion(file)) !== version)
        throw new Error("source_changed_during_read");
      const next = chunk.hasMore
        ? await this.file(file, chunk.nextOffset, version)
        : undefined;
      return {
        text: chunk.text,
        metadata: {
          kind: "file",
          path: file,
          version,
          offset,
          nextOffset: chunk.nextOffset,
          size: chunk.size,
          next,
          completeDocument: true,
          sourceHasMore: chunk.hasMore,
          revisionStatus: "unknown",
          git,
          observedAt: new Date().toISOString(),
        },
      };
    });
  }

  async fetch(id: string) {
    const reference = this.references.get(id);
    if (!reference)
      throw new Error(
        "evidence_not_found_or_expired: search again after a restart",
      );
    const { text, metadata } = await reference.read();
    return {
      id,
      title: reference.title,
      text,
      url: `${this.baseUrl}/evidence/${id}`,
      metadata: {
        ...metadata,
        sha256: createHash("sha256").update(text).digest("hex"),
      },
    };
  }
}
