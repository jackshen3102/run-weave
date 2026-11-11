import type * as Lark from "@larksuiteoapi/node-sdk";
import {
  FEISHU_MAX_ATTACHMENT_BYTES,
  isFeishuAttachmentName,
  type FeishuAttachment,
} from "@runweave/shared/feishu/bridge";

export class FeishuAttachmentError extends Error {}

export interface InboundAttachment {
  type: "image" | "file";
  key: string;
  fileName: string;
}

export function parseInboundAttachment(
  type: string,
  content: string,
): InboundAttachment | null {
  if (type !== "image" && type !== "file") return null;
  try {
    const parsed = JSON.parse(content);
    const key = type === "image" ? parsed.image_key : parsed.file_key;
    if (typeof key !== "string" || !key.trim() || key.length > 1024)
      return null;
    const fileName = type === "image" ? "image" : parsed.file_name;
    if (!isFeishuAttachmentName(fileName)) return null;
    return { type, key, fileName };
  } catch {
    return null;
  }
}

export async function downloadFeishuAttachment(
  client: Lark.Client,
  messageId: string,
  attachment: InboundAttachment,
  signal: AbortSignal,
): Promise<FeishuAttachment> {
  signal.throwIfAborted();
  // The SDK has no per-call AbortSignal. Release our wait at the deadline and
  // destroy a late response rather than keeping bridge shutdown waiting on it.
  const response = await new Promise<
    Awaited<ReturnType<typeof client.im.v1.messageResource.get>>
  >((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void client.im.v1.messageResource
      .get({
        path: { message_id: messageId, file_key: attachment.key },
        params: { type: attachment.type },
      })
      .then(
        (value) => {
          if (signal.aborted) value.getReadableStream().destroy();
          else resolve(value);
        },
        () =>
          reject(
            new FeishuAttachmentError(
              "附件下载失败，请检查飞书资源权限后重新发送",
            ),
          ),
      )
      .catch(reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
  const stream = response.getReadableStream();
  const abort = () => stream.destroy(new Error("attachment_download_aborted"));
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > FEISHU_MAX_ATTACHMENT_BYTES)
        throw new FeishuAttachmentError("附件超过 8 MiB，请缩小后重新发送");
      chunks.push(buffer);
    }
    if (!size) throw new FeishuAttachmentError("附件为空");
    const data = Buffer.concat(chunks, size);
    const fileName =
      attachment.type === "image"
        ? `image.${imageExtension(data)}`
        : attachment.fileName;
    return { fileName, dataBase64: data.toString("base64") };
  } finally {
    signal.removeEventListener("abort", abort);
    stream.destroy();
  }
}

function imageExtension(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "png";
  if (data.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "jpg";
  if (["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii")))
    return "gif";
  if (
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "webp";
  throw new FeishuAttachmentError(
    "图片格式不支持，请发送 PNG、JPEG、GIF 或 WebP",
  );
}
