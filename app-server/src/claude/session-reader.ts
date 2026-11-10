import { resolveClaudeConfiguration } from "@runweave/config-node/claude";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { constants, type Stats } from "node:fs";
import { ConversationReadError, scanConversationSource } from "../agents/conversation-source.js";

const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

type SessionSource = { file: string; stat: Stats; project: Stats; root: Stats };

/** Native files only: <configured Claude directory>/projects/<project>/<session UUID>.jsonl. */
export class ClaudeSessionReader {
  private readonly projectsRoot: string;

  constructor(projectsRoot?: string) {
    this.projectsRoot = path.resolve(projectsRoot ?? resolveClaudeConfiguration().projectsDirectory);
  }

  async scan(
    threadId: string,
    consume: (record: Record<string, unknown>, offset: number, truncated: boolean) => void,
    signal?: AbortSignal,
  ) {
    const source = await this.locate(threadId, signal);
    if (!source) return null;
    let stable = true;
    const signature = sourceSignature(source);
    const result = await scanConversationSource(source.file, consume, signal, async (stat) => {
      await this.validateSource(source, stat);
      stable &&= sourceSignature({ ...source, stat }) === signature;
    });
    return result ? { ...result, file: source.file, signature: stable ? signature : undefined } : null;
  }

  /** Revalidate the unique source before reusing only an existing short-text projection. */
  async isUnchanged(threadId: string, signature: string): Promise<boolean> {
    const source = await this.locate(threadId);
    if (!source || sourceSignature(source) !== signature) return false;
    const handle = await open(source.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      await this.validateSource(source, stat);
      const current = await handle.stat();
      await this.validateSource(source, current);
      return sourceSignature({ ...source, stat }) === signature &&
        sourceSignature({ ...source, stat: current }) === signature;
    } finally {
      await handle.close();
    }
  }

  private async validateSource(source: SessionSource, stat: Stats): Promise<void> {
    // Pin the opened descriptor AND its ancestors. A replacement during discovery/open/read
    // must never be published, even if it has a matching session ID or is still under projects.
    const [root, project, current] = await Promise.all([
      lstat(this.projectsRoot), lstat(path.dirname(source.file)), lstat(source.file),
    ]);
    if (!sameFile(root, source.root) || !sameFile(project, source.project) ||
        !sameFile(current, source.stat) || !sameFile(stat, source.stat) ||
        !stat.isFile() || stat.nlink !== 1 || stat.size < source.stat.size ||
        (stat.size === source.stat.size && stat.ctimeMs !== source.stat.ctimeMs) ||
        await realpath(source.file) !== source.file) {
      throw unsafeSource();
    }
  }

  private async locate(threadId: string, signal?: AbortSignal): Promise<SessionSource | null> {
    if (!SESSION_ID.test(threadId)) return null;
    try {
      if (await realpath(this.projectsRoot) !== this.projectsRoot) throw unsafeSource();
      const root = await lstat(this.projectsRoot);
      if (!root.isDirectory() || root.isSymbolicLink()) throw unsafeSource();
      let found: SessionSource | null = null;
      // Do not recurse into subagents, and never read other sessions to guess an identity.
      const directories = (await readdir(this.projectsRoot, { withFileTypes: true }))
        .filter(directory => directory.isDirectory() && !directory.isSymbolicLink());
      // Bound filesystem fan-out while still checking every project for duplicate identities.
      for (let index = 0; index < directories.length; index += 8) {
        signal?.throwIfAborted();
        const candidates = await Promise.allSettled(directories.slice(index, index + 8).map(async directory => {
          const projectPath = path.join(this.projectsRoot, directory.name);
          const file = path.join(projectPath, `${threadId}.jsonl`);
          try { return { file, projectPath, stat: await lstat(file) }; }
          catch (error) { if (missing(error)) return null; throw error; }
        }));
        for (const candidate of candidates) {
          signal?.throwIfAborted();
          if (candidate.status === "rejected") throw candidate.reason;
          if (!candidate.value) continue;
          const { file, projectPath, stat } = candidate.value;
          const project = await lstat(projectPath);
          if (!project.isDirectory() || project.isSymbolicLink() || !stat.isFile() ||
              stat.isSymbolicLink() || stat.nlink !== 1 || await realpath(file) !== file) throw unsafeSource();
          if (found) throw new ConversationReadError(409, "CLAUDE_SESSION_AMBIGUOUS", "Claude 会话来源不唯一");
          found = { file, stat, project, root };
        }
      }
      return found;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
}

function sourceSignature(source: SessionSource): string {
  const { file, stat, project, root } = source;
  return JSON.stringify([file, root.dev, root.ino, project.dev, project.ino,
    stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && !left.isSymbolicLink();
}

function missing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code));
}

function unsafeSource(): ConversationReadError {
  return new ConversationReadError(409, "CLAUDE_SOURCE_CHANGED", "Claude 会话来源已变化或不安全");
}
