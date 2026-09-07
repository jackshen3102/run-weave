import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type pg from "pg";
import type { UploadedAttachment } from "@runweave/shared/suiji";
import type { AttachmentStore } from "./local-files";
import { mutate, type Mutation } from "../records/mutations";
import { invalid, missing } from "../errors";
export class AttachmentService {
  constructor(
    private pool: pg.Pool,
    private store: AttachmentStore,
  ) {}
  async upload(
    context: Mutation,
    staged: Awaited<ReturnType<AttachmentStore["stage"]>>,
    name: string,
    mime: string,
  ) {
    // Strip display-name control characters; object paths never use this value.
    const fileName =
      name
        .split(/[\\/]/)
        .at(-1)
        // eslint-disable-next-line no-control-regex -- Display names must not contain control characters.
        ?.replace(/[\x00-\x1f\x7f]/g, "")
        .normalize("NFC")
        .slice(0, 200) || "attachment";
    let kind: UploadedAttachment["kind"];
    const bytes = await readFile(staged.path);
    if (!bytes.length) throw invalid("附件为空");
    if (
      mime === "text/markdown" &&
      /\.md(?:own)?$|\.markdown$/i.test(fileName)
    ) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (text.includes("\0")) throw new Error();
      } catch {
        throw invalid("Markdown 必须为有效 UTF-8");
      }
      kind = "markdown";
    } else {
      try {
        const decoded = sharp(bytes, {
          limitInputPixels: 40_000_000,
          failOn: "warning",
        });
        const metadata = await decoded.metadata();
        if (
          !["jpeg", "png"].includes(metadata.format ?? "") ||
          mime !== `image/${metadata.format}`
        )
          throw new Error();
        await decoded.stats();
      } catch {
        throw invalid("只接受完整 JPEG、PNG 图片和 UTF-8 Markdown");
      }
      kind = "image";
    }
    // Commit immutable bytes before metadata; failed SQL may leave an observable orphan, never a missing object.
    await this.store.commit(staged.key);
    return mutate(
      this.pool,
      context,
      "upload",
      {
        fileName,
        mimeType: mime,
        sha256: staged.sha256,
        byteSize: staged.byteSize,
      },
      async (client) => {
        const attachment: UploadedAttachment = {
          id: randomUUID(),
          kind,
          fileName,
          mimeType: mime,
          byteSize: staged.byteSize,
        };
        await client.query(
          "INSERT INTO attachments(id,owner_id,object_key,kind,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            attachment.id,
            context.ownerId,
            staged.key,
            kind,
            fileName,
            mime,
            staged.byteSize,
            staged.sha256,
          ],
        );
        return { attachment };
      },
    );
  }
  async content(owner: string, id: string) {
    const row = (
      await this.pool.query(
        "SELECT object_key,mime_type,byte_size,file_name FROM attachments WHERE owner_id=$1 AND id=$2",
        [owner, id],
      )
    ).rows[0];
    if (!row) throw missing();
    return {
      stream: this.store.read(row.object_key),
      mimeType: row.mime_type,
      byteSize: row.byte_size,
    };
  }
}
