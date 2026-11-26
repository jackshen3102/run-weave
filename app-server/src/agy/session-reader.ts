import { resolveAgyConfiguration } from "@runweave/config-node/agy";
import { constants, type Stats } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { ConversationReadError, scanConversationSource } from "../agents/conversation-source.js";
import { asRecord, readString } from "../codex/helpers.js";

const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

type SessionSource = {
  file: string;
  sessionDir: string;
  stat: Stats;
  root: Stats;
  logsDir: Stats;
};

/** Native files only: <configured agy brain>/<conversation UUID>/.system_generated/logs/transcript.jsonl. */
export class AgySessionReader {
  private readonly brainRoot: string;

  constructor(brainRoot?: string) {
    this.brainRoot = path.resolve(brainRoot ?? resolveAgyConfiguration().brainDirectory);
  }

  async scan(
    threadId: string,
    consume: (record: Record<string, unknown>, offset: number, truncated: boolean) => void,
    signal?: AbortSignal,
    expectedCwd?: string | null,
  ) {
    const source = await this.locate(threadId);
    if (!source) return null;
    if (expectedCwd) {
      const metaCwd = await this.readMetaCwd(source.sessionDir);
      if (metaCwd && path.resolve(metaCwd) !== path.resolve(expectedCwd)) {
        throw new ConversationReadError(409, "AGY_SESSION_MISMATCH", "AGY 会话工作目录不匹配");
      }
    }
    const signature = sourceSignature(source);
    const result = await scanConversationSource(source.file, consume, signal, async (stat) => {
      await this.validateSource(source, stat);
    });
    return result ? { ...result, file: source.file, signature } : null;
  }

  async isUnchanged(threadId: string, signature: string): Promise<boolean> {
    const source = await this.locate(threadId);
    if (!source || sourceSignature(source) !== signature) return false;
    const handle = await open(source.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      await this.validateSource(source, stat);
      const current = await handle.stat();
      await this.validateSource(source, current);
      return (
        sourceSignature({ ...source, stat }) === signature &&
        sourceSignature({ ...source, stat: current }) === signature
      );
    } finally {
      await handle.close();
    }
  }

  private async readMetaCwd(sessionDir: string): Promise<string | null> {
    const metaPath = path.join(sessionDir, ".runweave-agy-meta.json");
    try {
      const stat = await lstat(metaPath);
      if (!stat.isFile() || stat.isSymbolicLink() || (await realpath(metaPath)) !== metaPath) {
        return null;
      }
      const parsed = asRecord(JSON.parse(await readFile(metaPath, "utf8")));
      const cwd = readString(parsed?.cwd);
      return cwd && path.isAbsolute(cwd) ? cwd : null;
    } catch {
      return null;
    }
  }

  private async validateSource(source: SessionSource, stat: Stats): Promise<void> {
    const [root, logsDir, current] = await Promise.all([
      lstat(this.brainRoot),
      lstat(path.dirname(source.file)),
      lstat(source.file),
    ]);
    if (
      !sameFile(root, source.root) ||
      !sameFile(logsDir, source.logsDir) ||
      !sameSourceVersion(current, source.stat) ||
      !sameSourceVersion(stat, source.stat) ||
      (await realpath(source.file)) !== source.file
    ) {
      throw unsafeSource();
    }
  }

  private async locate(threadId: string): Promise<SessionSource | null> {
    if (!SESSION_ID.test(threadId)) return null;
    try {
      if ((await realpath(this.brainRoot)) !== this.brainRoot) throw unsafeSource();
      const root = await lstat(this.brainRoot);
      if (!root.isDirectory() || root.isSymbolicLink()) throw unsafeSource();

      const sessionDir = path.join(this.brainRoot, threadId);
      const sessionStat = await lstat(sessionDir);
      if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink() || (await realpath(sessionDir)) !== sessionDir) {
        throw unsafeSource();
      }

      const systemDir = path.join(sessionDir, ".system_generated");
      const systemStat = await lstat(systemDir);
      if (!systemStat.isDirectory() || systemStat.isSymbolicLink()) throw unsafeSource();

      const logsPath = path.join(systemDir, "logs");
      const logsDir = await lstat(logsPath);
      if (!logsDir.isDirectory() || logsDir.isSymbolicLink()) throw unsafeSource();

      const file = path.join(logsPath, "transcript.jsonl");
      const stat = await lstat(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (await realpath(file)) !== file ||
        !file.startsWith(`${this.brainRoot}${path.sep}`)
      ) {
        throw unsafeSource();
      }
      return { file, sessionDir, stat, root, logsDir };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
}

function sourceSignature(source: SessionSource): string {
  const { file, stat, logsDir, root } = source;
  return JSON.stringify([
    file,
    root.dev,
    root.ino,
    logsDir.dev,
    logsDir.ino,
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ]);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && !left.isSymbolicLink();
}

function sameSourceVersion(current: Stats, expected: Stats): boolean {
  return (
    sameFile(current, expected) &&
    current.isFile() &&
    current.nlink === 1 &&
    current.size === expected.size &&
    current.mtimeMs === expected.mtimeMs &&
    current.ctimeMs === expected.ctimeMs
  );
}

function unsafeSource(): ConversationReadError {
  return new ConversationReadError(409, "AGY_SOURCE_UNSAFE", "AGY 会话来源路径不安全");
}

function missing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException)?.code));
}
