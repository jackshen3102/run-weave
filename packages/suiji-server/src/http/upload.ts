import busboy from "busboy";
import type { Request } from "express";
import { SUIJI_LIMITS } from "@runweave/shared/suiji";
import { invalid, ServiceError } from "../errors";
import type { AttachmentStore } from "../storage/local-files";
export async function receiveUpload(req: Request, store: AttachmentStore) {
  const parser = busboy({
    headers: req.headers,
    limits: {
      files: 1,
      fields: 0,
      parts: 3,
      fileSize: SUIJI_LIMITS.attachmentBytes + 1,
    },
    defParamCharset: "utf8",
  });
  let file: Promise<Awaited<ReturnType<AttachmentStore["stage"]>>> | undefined;
  let name = "",
    mime = "",
    failure: unknown;
  parser.on("file", (field, stream, info) => {
    if (field !== "file") failure = invalid("multipart 字段必须为 file");
    name = info.filename;
    mime = info.mimeType;
    stream.on("limit", () => {
      failure = new ServiceError(413, "PAYLOAD_TOO_LARGE", "附件超过 5 MiB");
    });
    file = store.stage(stream);
    file.catch((error) => {
      failure = error;
      stream.resume();
    });
  });
  for (const event of ["filesLimit", "fieldsLimit", "partsLimit"] as const)
    parser.on(event, () => {
      failure = invalid("只允许一个 file 字段");
    });
  try {
    await new Promise<void>((resolve, reject) => {
      parser.on("close", resolve);
      parser.on("error", reject);
      req.on("aborted", () => parser.destroy(new Error("Upload aborted")));
      req.pipe(parser);
    });
    const staged = await file;
    if (failure) throw failure;
    if (!staged) throw invalid("请选择附件");
    return { staged, name, mime };
  } catch (error) {
    const staged = await file?.catch(() => undefined);
    if (staged) await store.discard(staged.key);
    throw error;
  }
}
