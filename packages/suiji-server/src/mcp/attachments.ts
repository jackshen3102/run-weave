import type { z } from "zod";
import type { AttachmentService } from "../storage/attachments";
import { invalid } from "../errors";
import { result } from "./results";
import type { attachmentInput } from "./schema";

export async function readAttachment(
  attachments: AttachmentService,
  owner: string,
  input: z.infer<typeof attachmentInput>,
) {
  const file = await attachments.content(owner, input.attachmentId);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of file.stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > file.byteSize) throw invalid("附件内容与元数据不一致");
    chunks.push(bytes);
  }
  if (size !== file.byteSize) throw invalid("附件内容不完整");
  const bytes = Buffer.concat(chunks);
  if (file.mimeType !== "text/markdown") {
    if (input.cursor) throw invalid("图片不支持分页游标");
    const value = result({
      attachmentId: input.attachmentId,
      mimeType: file.mimeType,
      byteSize: size,
    });
    value.content.push({
      type: "image",
      mimeType: file.mimeType,
      data: bytes.toString("base64"),
    });
    return value;
  }
  const scalars = [...new TextDecoder("utf-8", { fatal: true }).decode(bytes)];
  let offset = 0;
  if (input.cursor) {
    try {
      const cursor = JSON.parse(
        Buffer.from(input.cursor, "base64url").toString("utf8"),
      );
      if (
        cursor.id !== input.attachmentId ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 ||
        cursor.offset >= scalars.length
      )
        throw new Error();
      offset = cursor.offset;
    } catch {
      throw invalid("附件游标不合法或属于其他附件");
    }
  }
  const end = Math.min(offset + input.limit, scalars.length);
  return result({
    attachmentId: input.attachmentId,
    mimeType: file.mimeType,
    text: scalars.slice(offset, end).join(""),
    offset,
    totalScalars: scalars.length,
    truncated: end < scalars.length,
    nextCursor:
      end < scalars.length
        ? Buffer.from(
            JSON.stringify({ id: input.attachmentId, offset: end }),
          ).toString("base64url")
        : null,
  });
}
