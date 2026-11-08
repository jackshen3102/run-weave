import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, unlink, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { CodeReviewRun, CreateCodeReviewRequest, CodeReviewSnapshot, CodeReviewReport } from "@runweave/shared/terminal/code-review";

export class CodeReviewError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export interface SourceBinding {
  terminalId: string; projectId: string; rootPath: string;
}
export interface ReviewRecord {
  run: CodeReviewRun;
  requests: Array<{ terminalId: string; request: CreateCodeReviewRequest }>;
  source: SourceBinding;
  snapshotId: string | null;
  reviewerTaskId: string;
  reviewerThreadId: string | null;
  startedAt: number;
  dispatchId: string;
  recovered: boolean;
  delivery: { deliveryId: string; reportHash: string | null; attemptedAt: string | null };
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close();
    await rename(temporary, file);
  } finally { await handle.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
}

/** Reject every symlink component, including links that happen to point inside. */
export async function readOwnedFile(root: string, relative: string, maxBytes: number): Promise<Buffer> {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => !part || part === "." || part === ".."))
    throw new CodeReviewError(403, "artifact_invalid", "产物路径无效");
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== path.resolve(root))
    throw new CodeReviewError(403, "artifact_invalid", "产物目录不可越界或使用符号链接");
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new CodeReviewError(403, "artifact_invalid", "产物不能使用符号链接");
  }
  const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new CodeReviewError(413, "artifact_invalid", "产物类型或大小不支持");
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    const listed = await lstat(current);
    if (await realpath(current) !== current || listed.ino !== stat.ino || listed.dev !== stat.dev ||
        length !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      throw new CodeReviewError(409, "artifact_changed", "产物读取时已变化");
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

export class CodeReviewStore {
  backendIdentity = randomUUID();
  readonly records = new Map<string, ReviewRecord>();
  private tail = Promise.resolve();
  private failed = false;
  constructor(public directory: string) {}
  input(id: string) { return path.join(this.directory, id, "input"); }
  output(id: string) { return path.join(this.directory, id, "output"); }
  saved(id: string) { return path.join(this.directory, id, "saved"); }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.directory = await realpath(this.directory);
    await chmod(this.directory, 0o700);
    try {
      const ledger = JSON.parse(await readFile(path.join(this.directory, "state.json"), "utf8"));
      if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.records)) throw new Error("Invalid code review ledger");
      if (typeof ledger.backendIdentity === "string") this.backendIdentity = ledger.backendIdentity;
      for (const record of ledger.records as ReviewRecord[]) {
        if (!/^[a-f0-9-]{36}$/.test(record.run.reviewId) || this.records.has(record.run.reviewId)) throw new Error("Invalid code review ID");
        record.recovered = true;
        if (record.run.delivery === "writing") { record.run.delivery = "unknown"; record.run.deliveryError = "Backend 重启前回传结果不确定，不自动重复注入"; }
        this.records.set(record.run.reviewId, record);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await this.save();
  }
  async prepare(id: string) {
    for (const dir of [path.join(this.directory, id), this.input(id), this.output(id), this.saved(id)]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (await realpath(dir) !== path.resolve(dir) || (await lstat(dir)).isSymbolicLink())
        throw new CodeReviewError(403, "directory_invalid", "Review 目录不能使用符号链接");
    }
  }
  assertWritable() { if (this.failed) throw new CodeReviewError(503, "storage_unavailable", "Review 存储不可用，自动输入已停用"); }
  save(): Promise<void> {
    this.assertWritable();
    const body = structuredClone({ schemaVersion: 1, backendIdentity: this.backendIdentity, records: [...this.records.values()] });
    const work = this.tail.then(() => atomicJson(path.join(this.directory, "state.json"), body));
    this.tail = work;
    void work.catch(() => { this.failed = true; });
    return work;
  }
  async snapshot(id: string): Promise<CodeReviewSnapshot> {
    return JSON.parse((await readOwnedFile(this.input(id), "snapshot.json", 128 * 1024 * 1024)).toString("utf8"));
  }
  async report(id: string): Promise<CodeReviewReport> {
    return JSON.parse((await readOwnedFile(this.saved(id), "report.json", 2 * 1024 * 1024)).toString("utf8"));
  }
  async close() { await this.tail; }
}
