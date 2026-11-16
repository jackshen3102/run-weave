import { constants, type BigIntStats } from "node:fs";
import { open, mkdir, lstat, realpath, rename, rm, readdir, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID, type Hash } from "node:crypto";
import path from "node:path";
import type { DailyMaterial } from "@runweave/shared/daily-record";
import { hash } from "./data.js";

// Bump when normalization/filtering semantics change. No raw reasoning is indexed.
const version = 1;
const maximumIndexBytes = 64 * 1024 * 1024;
export interface NativeIndexMetrics {
  hits: number; appended: number; rebuilt: number; cacheFailures: number;
  sourceBytesRead: number; parsedBytes: number;
  indexBytesRead: number; indexBytesWritten: number;
}
export interface NativeParserState {
  threadId: string; cwd: string; historyStart: number; origin: DailyMaterial["origin"];
  calls: Array<[string, { name: string; input: string }]>;
  mutationIds: string[]; messageIds: string[];
}
export interface NativeIndexData {
  state: NativeParserState; materials: DailyMaterial[];
  excluded: Record<string, number>; issues: string[];
}
export interface NativeLine {
  path: string; line: number; byteOffset: number; byteLength: number; sha256: string;
}
interface Entry {
  version: number; file: string; identity: string; stamp: string; size: number;
  offset: number; line: number; prefixHash: string; tail: boolean; data: NativeIndexData;
}
const identity = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.birthtimeNs}`;
const stamp = (s: BigIntStats) => `${s.size}:${s.mtimeNs}:${s.ctimeNs}`;

/** Cache writes are outside source roots, under a private, symlink-free scope. */
export async function indexScope(base: string, root: string, provider: string, zone: string): Promise<string> {
  base = path.resolve(base);
  if (base === root || base.startsWith(root + path.sep)) throw new Error("索引目录不能位于来源目录内");
  for (let current = base; current !== path.dirname(current); current = path.dirname(current)) {
    const info = await lstat(current).catch(() => null);
    if (info?.isSymbolicLink()) throw new Error("索引目录包含软链接");
  }
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = path.join(base, hash(JSON.stringify([version, root, provider, zone])));
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) throw new Error("索引目录不安全");
  return directory;
}

export async function pruneIndex(directory: string, files: string[]): Promise<void> {
  const retained = new Set(files.map(file => hash(file) + ".json"));
  for (const name of await readdir(directory)) {
    if (/^[a-f0-9]{64}\.json$/.test(name) && !retained.has(name)) await rm(path.join(directory, name));
  }
}

/** A frozen source handle plus a disposable, atomically published parse checkpoint. */
export class NativeFileIndex {
  data?: NativeIndexData;
  private unchanged = false;
  private offset = 0;
  private line = 0;
  private prefixHash = hash("");
  private tail = false;
  private digest: Hash = createHash("sha256");
  private constructor(private readonly file: string, private readonly handle: FileHandle,
    private readonly before: BigIntStats, private readonly cache: string | undefined,
    private readonly metrics: NativeIndexMetrics) {}

  static async open(file: string, directory: string | undefined, metrics: NativeIndexMetrics): Promise<NativeFileIndex> {
    if (await realpath(file) !== file) throw new Error("源文件包含软链接");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (!Number.isSafeInteger(Number(before.size))) throw new Error("来源文件过大");
      const reader = new NativeFileIndex(file, handle, before, directory ? path.join(directory, hash(file) + ".json") : undefined, metrics);
      await reader.restore();
      return reader;
    } catch (error) { await handle.close(); throw error; }
  }
  private async restore(): Promise<void> {
    let saved: Entry | undefined;
    if (this.cache) {
      try {
        const info = await lstat(this.cache);
        if (!info.isFile() || info.isSymbolicLink() || info.size > maximumIndexBytes || (info.mode & 0o077) !== 0) throw new Error("unsafe index");
        const handle = await open(this.cache, constants.O_RDONLY | constants.O_NOFOLLOW);
        let raw: string;
        try { raw = await handle.readFile("utf8"); } finally { await handle.close(); }
        this.metrics.indexBytesRead += Buffer.byteLength(raw);
        const json = raw.slice(65);
        if (raw[64] !== "\n" || hash(json) !== raw.slice(0, 64)) throw new Error("corrupt index");
        const value = JSON.parse(json) as Entry;
        if (value.version !== version || value.file !== this.file || value.identity !== identity(this.before) ||
            !Number.isSafeInteger(value.size) || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > value.size ||
            !Number.isSafeInteger(value.line) || value.line < 0 || !/^[a-f0-9]{64}$/.test(value.prefixHash) ||
            !Array.isArray(value.data?.materials) || !Array.isArray(value.data?.state?.calls) ||
            !Array.isArray(value.data?.state?.mutationIds) || !Array.isArray(value.data?.state?.messageIds) ||
            !value.data?.excluded || !Array.isArray(value.data?.issues)) throw new Error("incompatible index");
        const state = value.data.state;
        if (typeof state.threadId !== "string" || typeof state.cwd !== "string" ||
            !Number.isSafeInteger(state.historyStart) || !["interactive", "subagent", "background"].includes(state.origin) ||
            !state.calls.every(call => Array.isArray(call) && typeof call[0] === "string" &&
              typeof call[1]?.name === "string" && typeof call[1]?.input === "string") ||
            ![...state.mutationIds, ...state.messageIds, ...value.data.issues].every(item => typeof item === "string") ||
            !Object.values(value.data.excluded).every(count => Number.isSafeInteger(count) && count >= 0) ||
            !value.data.materials.every(item => typeof item?.id === "string" && typeof item.day === "string" &&
              typeof item.threadId === "string" && typeof item.text === "string" && item.locator?.path === this.file &&
              Number.isSafeInteger(item.locator.byteOffset) && item.locator.byteOffset >= 0 &&
              item.locator.byteOffset + item.locator.byteLength <= value.offset)) throw new Error("invalid checkpoint data");
        saved = value;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.metrics.cacheFailures++; }
    }
    if (saved && Number(this.before.size) >= saved.size) {
      this.unchanged = saved.stamp === stamp(this.before);
      if (!this.unchanged) {
        const buffer = Buffer.alloc(512 * 1024);
        for (let position = 0; position < saved.offset;) {
          const { bytesRead } = await this.handle.read(buffer, 0, Math.min(buffer.length, saved.offset - position), position);
          if (!bytesRead) throw new Error("源文件读取期间被截断");
          this.metrics.sourceBytesRead += bytesRead;
          this.digest.update(buffer.subarray(0, bytesRead)); position += bytesRead;
        }
      }
      if (this.unchanged || this.digest.copy().digest("hex") === saved.prefixHash) {
        this.data = saved.data; this.offset = saved.offset; this.line = saved.line;
        this.prefixHash = saved.prefixHash; this.tail = saved.tail;
        if (this.unchanged) this.metrics.hits++; else this.metrics.appended++;
        return;
      }
    }
    this.digest = createHash("sha256"); this.metrics.rebuilt++;
  }
  async scan(consume: (row: Record<string, unknown>, locator: NativeLine) => void, issues: string[]): Promise<void> {
    if (this.unchanged) return;
    const buffer = Buffer.alloc(512 * 1024), size = Number(this.before.size);
    let position = this.offset, offset = this.offset, line = this.line;
    let pending = Buffer.alloc(0), discarding = false;
    this.tail = false;
    while (position < size) {
      const { bytesRead } = await this.handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) throw new Error("源文件读取期间被截断");
      this.metrics.sourceBytesRead += bytesRead; this.metrics.parsedBytes += bytesRead;
      const chunk = buffer.subarray(0, bytesRead), lastNewline = chunk.lastIndexOf(10);
      if (lastNewline >= 0) {
        this.prefixHash = this.digest.copy().update(chunk.subarray(0, lastNewline + 1)).digest("hex");
        this.offset = position + lastNewline + 1;
      }
      this.digest.update(chunk); position += bytesRead;
      const bytes = Buffer.concat([pending, chunk]);
      let start = 0, end: number;
      while ((end = bytes.indexOf(10, start)) !== -1) {
        line++;
        const raw = bytes.subarray(start, end + 1);
        if (!discarding && raw.length > 1) {
          try {
            const value: unknown = JSON.parse(raw.toString("utf8"));
            const row = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
            consume(row, { path: this.file, line, byteOffset: offset, byteLength: raw.length, sha256: hash(raw) });
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            issues.push(`${this.file}:${line}: 非法 JSON`);
          }
        }
        discarding = false; offset += raw.length; start = end + 1;
      }
      pending = Buffer.from(bytes.subarray(start));
      if (discarding || pending.length > 16 * 1024 * 1024) {
        if (!discarding) issues.push(`${this.file}:${line + 1}: 单行超过 16 MiB，未采集`);
        discarding = true; offset += pending.length; pending = Buffer.alloc(0);
      }
    }
    this.line = line; this.tail = Boolean(pending.length || discarding);
  }
  get incompleteTail(): boolean { return this.tail; }
  async finish(data: NativeIndexData): Promise<void> {
    const after = await this.handle.stat({ bigint: true });
    const current = await lstat(this.file, { bigint: true });
    if (identity(after) !== identity(this.before) || after.size < this.before.size ||
        current.isSymbolicLink() || identity(current) !== identity(this.before) ||
        (after.size === this.before.size && stamp(after) !== stamp(this.before))) throw new Error("源文件读取期间发生重写，需重新采集");
    if (!this.cache || this.unchanged) return;
    const entry: Entry = { version, file: this.file, identity: identity(this.before), stamp: stamp(this.before), size: Number(this.before.size),
      offset: this.offset, line: this.line, prefixHash: this.prefixHash, tail: this.tail, data };
    const temporary = this.cache + ".pending-" + randomUUID();
    try {
      const json = JSON.stringify(entry);
      if (Buffer.byteLength(json) + 65 > maximumIndexBytes) { this.metrics.cacheFailures++; return; }
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(hash(json) + "\n" + json); await handle.sync();
        this.metrics.indexBytesWritten += Buffer.byteLength(json) + 65;
      } finally { await handle.close(); }
      await rename(temporary, this.cache);
    } catch { this.metrics.cacheFailures++; }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  async close(): Promise<void> { await this.handle.close(); }
}
