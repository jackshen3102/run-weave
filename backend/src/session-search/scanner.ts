import { resolveAgyConfiguration } from "@runweave/config-node/agy";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, readFile, realpath, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { emptyNativeState, parseNativeRow, scanNativeLines } from "@runweave/agent-history-node";
import type { SessionSearchContext, SessionSearchProvider, SessionSearchSourceStatus, SessionSearchStatus } from "@runweave/shared/session-search";
import { resolveRepositoryIdentity } from "../repository/identity";
import { SEARCH_PARSER_VERSION, SessionSearchDatabase, searchHash, type IndexedSource } from "./database";

export interface NativeSearchRoot { provider: SessionSearchProvider; path: string }
const identity = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.birthtimeNs}`;
const stamp = (s: BigIntStats) => `${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
export function nativeSearchRoots(home = os.homedir()): NativeSearchRoot[] {
  const codex = process.env.CODEX_HOME || path.join(home, ".codex");
  let agyBrain = path.join(process.env.RUNWEAVE_AGY_CONFIG_DIR || process.env.AGY_CONFIG_DIR || path.join(home, ".gemini/antigravity-cli"), "brain");
  if (home === os.homedir()) {
    try { agyBrain = resolveAgyConfiguration().brainDirectory; } catch { /* Fallback to env/default home. */ }
  }
  return [
    { provider: "codex", path: path.join(codex, "sessions") },
    { provider: "codex", path: path.join(codex, "archived_sessions") },
    { provider: "pi", path: path.join(process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi/agent"), "sessions") },
    { provider: "claude", path: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "projects") },
    { provider: "agy", path: agyBrain },
  ];
}

export class NativeSearchScanner {
  private running?: Promise<void>;
  private stopped = false;
  private abort = new AbortController();
  private rootsState: SessionSearchSourceStatus[] = [];
  private lastScanAt: string | null = null;
  private metrics = { sourceBytesRead: 0, parsedBytes: 0, unchanged: 0, appended: 0, rebuilt: 0 };
  private repositories = new Map<string, Promise<string | null>>();
  constructor(readonly database: SessionSearchDatabase, private roots: NativeSearchRoot[]) {}

  refresh(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("session_search_closed"));
    return this.running ??= this.scan().catch(error => {
      if (!this.stopped) this.rootsState = this.rootsState.map(s => ({ ...s, status: "partial", issues: [...s.issues, String(error)].slice(0, 20) }));
    }).finally(() => { this.running = undefined; });
  }

  status(): SessionSearchStatus {
    const cached = this.database.sources();
    const sources = this.rootsState.length ? this.rootsState : [...new Set(this.roots.map(root => root.provider))].map(provider => {
      const rows = cached.filter(source => source.provider === provider);
      const issues = [...new Set(rows.flatMap(source => source.issues))].slice(0, 20);
      return { provider, status: issues.length ? "partial" as const : "ready" as const,
        files: rows.length, sessions: rows.filter(source => source.usable).length,
        indexedAt: rows.flatMap(source => source.indexedAt ? [source.indexedAt] : []).sort().at(-1) ?? null, issues };
    });
    const lastScanAt = this.lastScanAt ?? sources.flatMap(source => source.indexedAt ? [source.indexedAt] : []).sort().at(-1) ?? null;
    return { node: os.hostname(), state: this.running ? "indexing" : lastScanAt ? "ready" : "starting",
      generation: this.database.generation(), lastScanAt, metrics: { ...this.metrics }, sources };
  }

  private async scan() {
    const states = new Map<SessionSearchProvider, SessionSearchSourceStatus>();
    const seen = new Set<string>();
    const completedRoots: string[] = [];
    this.repositories.clear();
    this.metrics = { sourceBytesRead: 0, parsedBytes: 0, unchanged: 0, appended: 0, rebuilt: 0 };
    const files: { file: string; provider: SessionSearchProvider }[] = [];
    for (const root of this.roots) {
      this.abort.signal.throwIfAborted();
      let state = states.get(root.provider);
      if (!state) { state = { provider: root.provider, status: "ready", files: 0, sessions: 0, indexedAt: null, issues: [] }; states.set(root.provider, state); }
      try {
        const actual = await realpath(root.path);
        const collected = await this.discover(actual, root.provider);
        files.push(...collected.map(file => ({ file, provider: root.provider })));
        state.files += collected.length;
        completedRoots.push(actual);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && root.path.endsWith("archived_sessions")) continue;
        state.status = "unavailable";
        state.issues.push(`native_root_unavailable:${root.path}`);
      }
    }
    this.rootsState = [...states.values()];
    for (const item of files) {
      this.abort.signal.throwIfAborted();
      const id = searchHash(`${item.provider}:${item.file}`);
      if (seen.has(id)) continue;
      seen.add(id);
      try { await this.indexFile(id, item.file, item.provider); }
      catch (error) {
        if (this.stopped) break;
        this.database.setUnavailable(id, error instanceof Error ? error.message : "native_source_read_failed");
        const state = states.get(item.provider)!;
        state.status = "partial";
        state.issues.push(`native_source_unavailable:${item.file}`);
      }
    }
    if (this.stopped) return;
    for (const source of this.database.sources()) {
      if (!seen.has(source.id)) {
        if (completedRoots.some(root => source.file.startsWith(root + path.sep))) this.database.remove(source.id);
        else this.database.setUnavailable(source.id, "native_root_unavailable");
        continue;
      }
      const state = states.get(source.provider)!;
      if (source.usable) state.sessions++;
      if (source.issues.length) {
        if (state.status !== "unavailable") state.status = "partial";
        state.issues.push(...source.issues.map(issue => `${issue}:${source.file}`));
      }
    }
    this.lastScanAt = new Date().toISOString();
    for (const state of states.values()) { state.indexedAt = this.lastScanAt; state.issues = [...new Set(state.issues)].slice(0, 20); }
    this.rootsState = [...states.values()];
  }

  private async discover(root: string, provider: SessionSearchProvider): Promise<string[]> {
    const files: string[] = [];
    let entries = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 8) throw new Error("native_discovery_depth_limit");
      for (const item of await readdir(directory, { withFileTypes: true })) {
        this.abort.signal.throwIfAborted();
        if (++entries > 100_000) throw new Error("native_discovery_entry_limit");
        if (item.isSymbolicLink()) continue;
        const file = path.join(directory, item.name);
        if (item.isDirectory()) await walk(file, depth + 1);
        else if (item.isFile() && item.name.endsWith(".jsonl")) {
          if (provider === "agy") {
            if (item.name === "transcript.jsonl" && file.endsWith(`${path.sep}.system_generated${path.sep}logs${path.sep}transcript.jsonl`)) {
              files.push(file);
            }
          } else {
            files.push(file);
          }
        }
      }
    };
    await walk(root, 0);
    return files.sort();
  }

  private async indexFile(id: string, file: string, provider: SessionSearchProvider) {
    if (await realpath(file) !== file) throw new Error("native_source_symlink");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let observed: BigIntStats | undefined;
    try {
      const before = await handle.stat({ bigint: true });
      observed = before;
      if (!before.isFile() || before.size > BigInt(512 * 1024 * 1024)) throw new Error("native_source_size_limit");
      const previous = this.database.source(id);
      let agyMetaCwd: string | null = null;
      if (provider === "agy") {
        const metaPath = path.resolve(path.dirname(file), "../..", ".runweave-agy-meta.json");
        try {
          const metaStat = await lstat(metaPath);
          if (metaStat.isFile() && !metaStat.isSymbolicLink()) {
            const meta = JSON.parse(await readFile(metaPath, "utf8")) as { cwd?: unknown };
            if (typeof meta.cwd === "string" && path.isAbsolute(meta.cwd)) {
              agyMetaCwd = meta.cwd;
            }
          }
        } catch {
          // Ignore missing or unreadable agy session metadata.
        }
      }
      const agyMetaChanged = provider === "agy" && Boolean(agyMetaCwd) && previous?.state.cwd !== agyMetaCwd;
      if (!agyMetaChanged && previous?.stamp === stamp(before) && previous.parserVersion === SEARCH_PARSER_VERSION && (previous.usable || previous.state.unsupported)) { this.metrics.unchanged++; return; }
      const digest = createHash("sha256");
      let appended = false;
      if (!agyMetaChanged && previous && previous.usable && previous.parserVersion === SEARCH_PARSER_VERSION && previous.identity === identity(before) && Number(before.size) >= previous.offset) {
        const buffer = Buffer.alloc(256 * 1024);
        for (let position = 0; position < previous.offset;) {
          this.abort.signal.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, previous.offset - position), position);
          if (!bytesRead) throw new Error("native_source_truncated_during_read");
          digest.update(buffer.subarray(0, bytesRead)); position += bytesRead; this.metrics.sourceBytesRead += bytesRead;
        }
        appended = digest.copy().digest("hex") === previous.prefixHash;
      }
      if (!appended && previous) this.database.setUnavailable(id, "native_source_rebuilding");
      const source: IndexedSource = appended && previous ? { ...previous, state: { ...previous.state }, issues: previous.issues.filter(issue => issue !== "native_incomplete_tail") } : {
        id, file, provider, generation: randomUUID(), identity: identity(before), stamp: "", size: 0, offset: 0,
        line: 0, prefixHash: searchHash(""), state: emptyNativeState(), repositoryId: null, indexedAt: null,
        usable: false, issues: [], parserVersion: SEARCH_PARSER_VERSION,
      };
      if (!previous) this.database.saveSource(source);
      if (provider === "agy" && agyMetaCwd) {
        source.state.cwd = agyMetaCwd;
      }
      if (appended) this.metrics.appended++; else this.metrics.rebuilt++;
      const pending: (() => void)[] = [];
      const flush = () => { if (pending.length) this.database.db.transaction(() => { for (const run of pending) run(); })(); pending.length = 0; };
      const scanned = await scanNativeLines({ file, handle, start: source.offset, end: Number(before.size), line: source.line,
        digest: appended ? digest : createHash("sha256"), signal: this.abort.signal,
        onBytes: bytes => { flush(); this.metrics.sourceBytesRead += bytes; this.metrics.parsedBytes += bytes; },
        onIssue: issue => { if (source.issues.length < 20) source.issues.push(issue); },
        onRow: (row, location) => {
          const parsed = parseNativeRow(provider, row, source.state, location);
          if (parsed.issue && source.issues.length < 20) source.issues.push(parsed.issue);
          if (parsed.node) pending.push(() => this.database.node(source, parsed.node!, location.byteOffset + location.byteLength));
          for (const record of parsed.records) pending.push(() => this.database.insert(source, record));
          if (pending.length >= 100) flush();
        },
      });
      flush();
      const [after, current] = await Promise.all([handle.stat({ bigint: true }), lstat(file, { bigint: true })]);
      if (identity(after) !== identity(before) || identity(current) !== identity(before) || after.size < before.size ||
          current.isSymbolicLink() || after.size === before.size && stamp(after) !== stamp(before)) throw new Error("native_source_changed_during_read");
      if (!source.state.threadId || !path.isAbsolute(source.state.cwd)) throw new Error("native_source_identity_unavailable");
      source.offset = scanned.offset; source.line = scanned.line; source.prefixHash = scanned.prefixHash;
      source.identity = identity(before); source.stamp = stamp(before); source.size = Number(before.size);
      if (scanned.incompleteTail) source.issues.push("native_incomplete_tail");
      source.repositoryId = await this.repository(source.state.cwd);
      if (!source.repositoryId) source.issues.push("native_repository_identity_unavailable");
      source.usable = !source.state.unsupported;
      source.indexedAt = new Date().toISOString();
      this.database.finish(source);
    } catch (error) {
      // Invalid immutable formats are retried after the native file changes.
      if (observed && error instanceof Error && ["native_source_identity_unavailable", "native_thread_identity_changed", "native_working_directory_changed", "native_source_size_limit"].includes(error.message)) {
        const failed = this.database.source(id);
        if (failed) this.database.saveSource({ ...failed, stamp: stamp(observed), parserVersion: SEARCH_PARSER_VERSION, state: { ...failed.state, unsupported: true } });
      }
      throw error;
    } finally { await handle.close(); }
  }

  private repository(cwd: string): Promise<string | null> {
    let result = this.repositories.get(cwd);
    if (!result) { result = resolveRepositoryIdentity(cwd).then(value => value.repositoryId).catch(() => null); this.repositories.set(cwd, result); }
    return result;
  }

  async context(id: string): Promise<SessionSearchContext> {
    const { target, context, paired, truncated: contextTruncated } = this.database.records(id);
    const source = this.database.source(target.source)!;
    const rows = [...new Map([target, ...context, ...paired].map(row => [row.id, row])).values()];
    const verified = new Map<string, "verified" | "changed" | "missing">();
    let handle: FileHandle | undefined;
    try {
      if (await realpath(source.file) !== source.file) throw new Error("source_symlink");
      handle = await open(source.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      for (const row of rows) {
        const locator = JSON.parse(row.location) as SessionSearchContext["hit"]["location"];
        const bytes = Buffer.alloc(locator.byteLength);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, locator.byteOffset);
        verified.set(row.id, bytesRead === bytes.length && searchHash(bytes.toString("utf8")) === locator.sha256 ? "verified" : "changed");
      }
    } catch (error) { for (const row of rows) verified.set(row.id, (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "changed"); }
    finally { await handle?.close(); }
    const sourceState = verified.get(target.id) ?? "changed";
    let remaining = 64_000, truncated = false;
    const safeRows = new Map(rows.map(row => {
      const text = verified.get(row.id) === "verified" ? this.database.text(row.id) : "";
      const bounded = text.slice(0, remaining);
      remaining -= bounded.length;
      if (bounded.length < text.length || text.length === 32_000) truncated = true;
      return [row.id, this.database.hit(row, bounded)] as const;
    }));
    return { hit: safeRows.get(target.id)!, records: context.map(row => safeRows.get(row.id)!), paired: paired.map(row => safeRows.get(row.id)!), sourceState,
      partial: contextTruncated || truncated || sourceState !== "verified" || rows.some(row => verified.get(row.id) !== "verified") || source.issues.length > 0 };
  }

  async close() {
    this.stopped = true; this.abort.abort();
    await this.running;
    this.database.close();
  }
}
