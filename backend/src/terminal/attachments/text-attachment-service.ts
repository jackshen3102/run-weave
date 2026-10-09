import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  TERMINAL_TEXT_ATTACHMENT_LIMITS as limits,
  type CreateTerminalTextAttachmentRequest,
  type TerminalTextAttachment,
  type TerminalTextAttachmentOperation,
} from "@runweave/shared/terminal/text-attachments";

const DAY = 86_400_000;
const safeId = /^[A-Za-z0-9_-]{1,200}$/;
const attachmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    sessionId: z.string().regex(safeId),
    panelId: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    operationId: z.string().min(1),
    purpose: z.enum(["composer", "tui"]),
    utf16Length: z.number().int().nonnegative(),
    utf8Bytes: z.number().int().nonnegative().max(limits.maxBytes),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
    retainedAt: z.string().datetime(),
    state: z.enum(["draft", "referenced"]),
  })
  .strict();
const operationSchema = z
  .object({
    operationId: z.string().min(1),
    kind: z.enum(["create", "insert", "composer"]),
    status: z.enum(["saved", "dispatching", "accepted", "rejected", "unknown"]),
    attachmentIds: z.array(z.string().uuid()),
    reason: z.string().optional(),
    fingerprint: z.string(),
  })
  .strict();
const indexSchema = z
  .object({
    schemaVersion: z.literal(1),
    deletedAt: z.string().datetime().optional(),
    attachments: z.array(attachmentSchema),
    operations: z.array(operationSchema),
  })
  .strict();
type AttachmentRecord = z.infer<typeof attachmentSchema>;
type Index = z.infer<typeof indexSchema>;

export class TextAttachmentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function attachmentFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Owns managed files and atomic metadata. No clipboard body enters metadata or logs. */
export class TerminalTextAttachmentService {
  private tail: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  constructor(readonly root: string) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new TextAttachmentError(503, "附件服务已关闭"));
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }
  private directory(sessionId: string): string {
    if (!safeId.test(sessionId))
      throw new TextAttachmentError(400, "无效 session ID");
    return path.join(this.root, sessionId);
  }
  private async safeDirectory(
    directory: string,
    create = false,
  ): Promise<void> {
    if (create) await mkdir(directory, { mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new TextAttachmentError(409, "附件目录不可用");
  }
  private async ensureDirectory(directory: string): Promise<void> {
    try {
      await this.safeDirectory(directory, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await this.safeDirectory(directory);
    }
  }
  private async readFile(file: string): Promise<Buffer> {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 16 * limits.maxBytes)
        throw new TextAttachmentError(409, "附件文件不可用");
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }
  private async load(sessionId: string): Promise<Index> {
    const directory = this.directory(sessionId);
    await this.safeDirectory(this.root);
    try {
      await this.safeDirectory(directory);
      const index = indexSchema.parse(
        JSON.parse(
          (await this.readFile(path.join(directory, "metadata.json"))).toString(
            "utf8",
          ),
        ),
      );
      if (index.attachments.some((item) => item.sessionId !== sessionId))
        throw new TextAttachmentError(409, "附件归属不明");
      return index;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { schemaVersion: 1, attachments: [], operations: [] };
      throw error;
    }
  }
  private async atomic(file: string, data: string | Buffer): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    const directory = await open(path.dirname(file), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  private async save(sessionId: string, index: Index): Promise<void> {
    await this.atomic(
      path.join(this.directory(sessionId), "metadata.json"),
      JSON.stringify(index),
    );
  }
  private describe(record: AttachmentRecord): TerminalTextAttachment {
    const filePath = path.join(
      this.directory(record.sessionId),
      record.id,
      "pasted-text.txt",
    );
    return {
      ...record,
      filePath,
      tuiReference: ` ${JSON.stringify(filePath)} `,
      insertOperationId: `${record.operationId}:insert`,
    };
  }
  private find(index: Index, id: string): AttachmentRecord {
    const record = index.attachments.find((item) => item.id === id);
    if (!record) throw new TextAttachmentError(410, "附件已失效");
    if (
      record.state === "draft" &&
      Date.now() - Date.parse(record.retainedAt) >= 7 * DAY
    )
      throw new TextAttachmentError(410, "附件已过期");
    return record;
  }
  private async content(record: AttachmentRecord): Promise<string> {
    await this.safeDirectory(
      path.join(this.directory(record.sessionId), record.id),
    );
    const bytes = await this.readFile(this.describe(record).filePath);
    const text = bytes.toString("utf8");
    if (
      bytes.length !== record.utf8Bytes ||
      text.length !== record.utf16Length ||
      createHash("sha256").update(bytes).digest("hex") !== record.sha256
    )
      throw new TextAttachmentError(410, "附件内容校验失败");
    return text;
  }
  async initialize(): Promise<void> {
    await this.ensureDirectory(this.root);
    await this.serial(async () => {
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !safeId.test(entry.name)) continue;
        try {
          const index = await this.load(entry.name);
          let changed = false;
          for (const operation of index.operations)
            if (operation.status === "dispatching") {
              operation.status = "unknown";
              operation.reason = "Backend 重启，交付结果未知";
              changed = true;
            }
          if (changed) await this.save(entry.name, index);
        } catch {
          /* Unknown or corrupt ownership is never deleted. */
        }
      }
    });
  }
  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      void this.cleanup().catch(() => undefined);
    }, DAY);
    this.timer.unref();
  }
  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.closed = true;
    await this.tail;
  }
  create(
    sessionId: string,
    request: CreateTerminalTextAttachmentRequest,
  ): Promise<TerminalTextAttachment> {
    return this.serial(async () => {
      const index = await this.load(sessionId);
      const fingerprint = attachmentFingerprint(request);
      const existing = index.operations.find(
        (item) => item.operationId === request.operationId,
      );
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.kind !== "create")
          throw new TextAttachmentError(409, "operationId 已用于其他请求");
        const record = this.find(index, existing.attachmentIds[0]!);
        await this.content(record);
        return this.describe(record);
      }
      const bytes = Buffer.from(request.text, "utf8");
      if (bytes.toString("utf8") !== request.text)
        throw new TextAttachmentError(
          400,
          "文本包含无法无损保存的 UTF-16 字符",
        );
      if (request.text.length < limits.threshold && !request.preparationId)
        throw new TextAttachmentError(400, "文本未达到附件阈值");
      if (bytes.length > limits.maxBytes)
        throw new TextAttachmentError(
          413,
          "单份文本附件超过 1 MiB，原文已保留",
        );
      if (
        index.attachments.reduce((sum, item) => sum + item.utf8Bytes, 0) +
          bytes.length >
        limits.sessionMaxBytes
      )
        throw new TextAttachmentError(
          413,
          "当前会话附件超过 100 MiB，原文已保留",
        );
      if (index.deletedAt) throw new TextAttachmentError(410, "session 已删除");
      await this.ensureDirectory(this.directory(sessionId));
      const record: AttachmentRecord = {
        schemaVersion: 1,
        id: randomUUID(),
        sessionId,
        panelId: request.panelId,
        threadId: request.expectedThreadId ?? null,
        operationId: request.operationId,
        purpose: request.purpose,
        utf16Length: request.text.length,
        utf8Bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        createdAt: new Date().toISOString(),
        retainedAt: new Date().toISOString(),
        state: "draft",
      };
      const directory = path.join(this.directory(sessionId), record.id);
      await this.ensureDirectory(directory);
      await this.atomic(path.join(directory, "pasted-text.txt"), bytes);
      index.attachments.push(record);
      index.operations.push({
        operationId: request.operationId,
        kind: "create",
        fingerprint,
        status: "saved",
        attachmentIds: [record.id],
      });
      await this.save(sessionId, index);
      return this.describe(record);
    });
  }
  get(sessionId: string, id: string): Promise<TerminalTextAttachment> {
    return this.serial(async () =>
      this.describe(this.find(await this.load(sessionId), id)),
    );
  }
  read(sessionId: string, id: string): Promise<string> {
    return this.serial(async () =>
      this.content(this.find(await this.load(sessionId), id)),
    );
  }
  retain(sessionId: string, id: string): Promise<void> {
    return this.serial(async () => {
      const index = await this.load(sessionId);
      const record = this.find(index, id);
      if (record.state === "draft") {
        record.retainedAt = new Date().toISOString();
        await this.save(sessionId, index);
      }
    });
  }
  release(sessionId: string, id: string): Promise<void> {
    return this.serial(async () => {
      const index = await this.load(sessionId);
      const record = this.find(index, id);
      if (record.state !== "draft")
        throw new TextAttachmentError(409, "已引用附件不能删除");
      await this.safeDirectory(path.join(this.directory(sessionId), record.id));
      // Delete files first; a failure leaves metadata available for cleanup retry.
      await rm(path.join(this.directory(sessionId), record.id), {
        recursive: true,
      });
      index.attachments = index.attachments.filter((item) => item.id !== id);
      await this.save(sessionId, index);
    });
  }
  operation(
    sessionId: string,
    operationId: string,
  ): Promise<TerminalTextAttachmentOperation & { fingerprint: string }> {
    return this.serial(async () => {
      const operation = (await this.load(sessionId)).operations.find(
        (item) => item.operationId === operationId,
      );
      if (!operation) throw new TextAttachmentError(404, "操作尚未确认");
      return { ...operation };
    });
  }
  protect(
    sessionId: string,
    operation: TerminalTextAttachmentOperation,
    fingerprint: string,
  ): Promise<void> {
    return this.serial(async () => {
      const index = await this.load(sessionId);
      if (
        index.operations.some(
          (item) => item.operationId === operation.operationId,
        )
      )
        throw new TextAttachmentError(409, "操作已存在，请查询结果");
      for (const id of operation.attachmentIds) {
        const record = this.find(index, id);
        await this.content(record);
        record.state = "referenced";
      }
      index.operations.push({ ...operation, fingerprint });
      await this.save(sessionId, index);
    });
  }
  finish(
    sessionId: string,
    operationId: string,
    status: "accepted" | "rejected" | "unknown",
    reason?: string,
  ): Promise<void> {
    return this.serial(async () => {
      const index = await this.load(sessionId);
      const operation = index.operations.find(
        (item) => item.operationId === operationId,
      );
      if (!operation) throw new TextAttachmentError(404, "操作不存在");
      operation.status = status;
      operation.reason = reason;
      await this.save(sessionId, index);
    });
  }
  deleted(sessionId: string): Promise<void> {
    return this.serial(async () => {
      const index = await this.load(sessionId);
      await this.ensureDirectory(this.directory(sessionId));
      index.deletedAt ??= new Date().toISOString();
      await this.save(sessionId, index);
    });
  }
  cleanup(now = Date.now()): Promise<void> {
    return this.serial(async () => {
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !safeId.test(entry.name)) continue;
        try {
          const index = await this.load(entry.name);
          if (index.deletedAt && now - Date.parse(index.deletedAt) >= 7 * DAY) {
            await rm(this.directory(entry.name), { recursive: true });
            continue;
          }
          for (const record of [...index.attachments]) {
            if (
              record.state === "draft" &&
              now - Date.parse(record.retainedAt) >= 7 * DAY
            ) {
              await this.safeDirectory(
                path.join(this.directory(entry.name), record.id),
              );
              await rm(path.join(this.directory(entry.name), record.id), {
                recursive: true,
              });
              index.attachments = index.attachments.filter(
                (item) => item.id !== record.id,
              );
            }
          }
          // Only known temporary filenames inside known directories are eligible.
          for (const directory of [
            this.directory(entry.name),
            ...index.attachments.map((item) =>
              path.join(this.directory(entry.name), item.id),
            ),
          ]) {
            await this.safeDirectory(directory);
            for (const file of await readdir(directory, {
              withFileTypes: true,
            })) {
              if (
                !file.isFile() ||
                !/^(metadata\.json|pasted-text\.txt)\.[a-f0-9-]{36}\.tmp$/.test(
                  file.name,
                )
              )
                continue;
              const full = path.join(directory, file.name);
              if (now - (await lstat(full)).mtimeMs >= DAY) await rm(full);
            }
          }
          await this.save(entry.name, index);
        } catch {
          /* Missing files or unknown metadata must never trigger guessed deletion. */
        }
      }
    });
  }
}
