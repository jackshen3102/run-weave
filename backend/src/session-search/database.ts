import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { openEvolutionDatabase } from "../evolution/storage/sqlite-driver";
import type { NativeRecordLocation, SessionSearchHit, SessionSearchOrigin, SessionSearchProvider, SessionSearchQuery, SessionSearchResponse, SessionSearchStatus } from "@runweave/shared/session-search";
import type { NativeSessionState, ParsedNativeRecord } from "@runweave/agent-history-node";
import { redactExcerpt } from "../experience/evidence";

export const SEARCH_PARSER_VERSION = 2;
export const searchHash = (text: string) => createHash("sha256").update(text).digest("hex");
export interface IndexedSource {
  id: string; file: string; provider: SessionSearchProvider; generation: string; identity: string;
  stamp: string; size: number; offset: number; line: number; prefixHash: string;
  state: NativeSessionState; repositoryId: string | null; indexedAt: string | null;
  usable: boolean; issues: string[]; parserVersion: number;
}
interface StoredSource extends Omit<IndexedSource, "state" | "issues" | "usable"> { state: string; issues: string; usable: number }
interface RecordRow {
  id: string; source: string; generation: string; nativeId: string; nodeId: string | null;
  kind: SessionSearchHit["kind"]; callId: string | null; toolName: string | null;
  occurredAt: string | null; location: string; endOffset: number; active: number;
}
type HitRow = RecordRow & { threadId: string; provider: SessionSearchProvider; cwd: string; title: string;
  origin: SessionSearchOrigin; repositoryId: string | null; snippet?: string };

/** Disposable native-transcript projection. No Activity, Work History or experience content is ingested. */
export class SessionSearchDatabase {
  readonly db: Database.Database;
  private insertRecord: Database.Statement;
  private insertChunk: Database.Statement;
  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = openEvolutionDatabase(file);
    chmodSync(file, 0o600);
    const version = this.db.pragma("user_version", { simple: true });
    if (version !== 0 && version !== 1) { this.db.close(); throw new Error("session_search_schema_unsupported"); }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, file TEXT NOT NULL UNIQUE, provider TEXT NOT NULL,
        generation TEXT NOT NULL, identity TEXT NOT NULL, stamp TEXT NOT NULL, size INTEGER NOT NULL,
        offset INTEGER NOT NULL, line INTEGER NOT NULL, prefixHash TEXT NOT NULL, state TEXT NOT NULL,
        repositoryId TEXT, indexedAt TEXT, usable INTEGER NOT NULL, issues TEXT NOT NULL, parserVersion INTEGER NOT NULL,
        threadId TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, origin TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, source TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        generation TEXT NOT NULL, nativeId TEXT NOT NULL, nodeId TEXT, kind TEXT NOT NULL, callId TEXT, toolName TEXT,
        occurredAt TEXT, location TEXT NOT NULL, endOffset INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS records_source ON records(source,generation,endOffset);
      CREATE INDEX IF NOT EXISTS records_native ON records(source,generation,nativeId,endOffset);
      CREATE INDEX IF NOT EXISTS records_calls ON records(source,generation,callId);
      CREATE INDEX IF NOT EXISTS records_kind ON records(kind,active);
      CREATE TABLE IF NOT EXISTS nodes(source TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        generation TEXT NOT NULL,id TEXT NOT NULL,parent TEXT,offset INTEGER NOT NULL,PRIMARY KEY(source,generation,id,offset));
      CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY,recordId TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        chat TEXT NOT NULL,act TEXT NOT NULL,output TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chunks_record ON chunks(recordId);
      CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(chat,act,output,content=chunks,content_rowid=id,tokenize=trigram);
      CREATE TRIGGER IF NOT EXISTS chunk_insert AFTER INSERT ON chunks BEGIN
        INSERT INTO search_fts(rowid,chat,act,output) VALUES(new.id,new.chat,new.act,new.output); END;
      CREATE TRIGGER IF NOT EXISTS chunk_delete AFTER DELETE ON chunks BEGIN
        INSERT INTO search_fts(search_fts,rowid,chat,act,output) VALUES('delete',old.id,old.chat,old.act,old.output); END;
      CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES(1,0); PRAGMA user_version=1;
    `);
    this.insertRecord = this.db.prepare("INSERT OR IGNORE INTO records(id,source,generation,nativeId,nodeId,kind,callId,toolName,occurredAt,location,endOffset) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    this.insertChunk = this.db.prepare("INSERT INTO chunks(recordId,chat,act,output) VALUES(?,?,?,?)");
    // Interrupted batches are not committed content. Keep the last checkpoint, discard staging rows.
    this.db.exec("DELETE FROM records WHERE NOT EXISTS(SELECT 1 FROM sources s WHERE s.id=records.source AND s.generation=records.generation AND records.endOffset<=s.offset); DELETE FROM nodes WHERE NOT EXISTS(SELECT 1 FROM sources s WHERE s.id=nodes.source AND s.generation=nodes.generation AND nodes.offset<=s.offset)");
  }

  generation(): number { return (this.db.prepare("SELECT generation FROM meta WHERE id=1").get() as { generation: number }).generation; }
  changed() { this.db.exec("UPDATE meta SET generation=generation+1 WHERE id=1"); }
  sources(): IndexedSource[] {
    return (this.db.prepare("SELECT * FROM sources").all() as StoredSource[]).map(row => ({ ...row,
      state: JSON.parse(row.state) as NativeSessionState, issues: JSON.parse(row.issues) as string[], usable: Boolean(row.usable) }));
  }
  source(id: string) { return this.sources().find(row => row.id === id); }
  saveSource(source: IndexedSource) {
    this.db.prepare(`INSERT INTO sources VALUES(@id,@file,@provider,@generation,@identity,@stamp,@size,@offset,@line,@prefixHash,
      @state,@repositoryId,@indexedAt,@usable,@issues,@parserVersion,@threadId,@cwd,@title,@origin)
      ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,identity=excluded.identity,stamp=excluded.stamp,size=excluded.size,
      offset=excluded.offset,line=excluded.line,prefixHash=excluded.prefixHash,state=excluded.state,repositoryId=excluded.repositoryId,
      indexedAt=excluded.indexedAt,usable=excluded.usable,issues=excluded.issues,parserVersion=excluded.parserVersion,
      threadId=excluded.threadId,cwd=excluded.cwd,title=excluded.title,origin=excluded.origin`).run({ ...source,
      state: JSON.stringify({ ...source.state, title: redactExcerpt(source.state.title) }), issues: JSON.stringify(source.issues), usable: Number(source.usable),
      threadId: source.state.threadId, cwd: source.state.cwd, title: redactExcerpt(source.state.title), origin: source.state.origin });
  }
  setUnavailable(id: string, issue: string) {
    this.discardStaging(id);
    this.db.prepare("UPDATE sources SET usable=0,issues=? WHERE id=?").run(JSON.stringify([issue]), id);
    this.changed();
  }
  remove(id: string) { this.db.prepare("DELETE FROM sources WHERE id=?").run(id); this.changed(); }
  private discardStaging(id: string) {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM records WHERE source=? AND NOT EXISTS(SELECT 1 FROM sources s WHERE s.id=records.source AND s.generation=records.generation AND records.endOffset<=s.offset)").run(id);
      this.db.prepare("DELETE FROM nodes WHERE source=? AND NOT EXISTS(SELECT 1 FROM sources s WHERE s.id=nodes.source AND s.generation=nodes.generation AND nodes.offset<=s.offset)").run(id);
    })();
  }

  insert(source: IndexedSource, record: ParsedNativeRecord) {
    if (!record.text.trim() && !record.toolName) return;
    if (record.text.length > 2 * 1024 * 1024) { source.issues.push("native_record_index_limit"); return; }
    const id = searchHash(`${source.id}:${source.generation}:${record.location.byteOffset}:${record.id}`);
    const inserted = this.insertRecord.run(id, source.id, source.generation, record.id, record.nodeId,
      record.kind, record.callId, record.toolName, record.occurredAt, JSON.stringify(record.location), record.location.byteOffset + record.location.byteLength);
    if (!inserted.changes) return;
    const text = redactExcerpt(record.text);
    const column = record.kind === "request" || record.kind === "file_change" ? 1 : record.kind === "result" ? 2 : 0;
    const combined = record.toolName ? `${record.toolName}\n${text}` : text;
    for (let start = 0; start < combined.length; start += 4000) {
      const values = ["", "", ""];
      values[column] = combined.slice(start, start + 4200);
      this.insertChunk.run(id, ...values);
    }
  }
  node(source: IndexedSource, node: { id: string; parent: string | null }, offset: number) {
    this.db.prepare("INSERT OR REPLACE INTO nodes VALUES(?,?,?,?,?)").run(source.id, source.generation, node.id, node.parent, offset);
  }
  finish(source: IndexedSource) {
    this.db.transaction(() => {
      if (source.state.branching) this.selectBranch(source);
      source.issues = [...new Set(source.issues)].slice(0, 20);
      this.saveSource(source);
      this.db.prepare("DELETE FROM records WHERE source=? AND (generation<>? OR endOffset>?)").run(source.id, source.generation, source.offset);
      this.db.prepare("DELETE FROM nodes WHERE source=? AND (generation<>? OR offset>?)").run(source.id, source.generation, source.offset);
      this.changed();
    })();
  }
  private selectBranch(source: IndexedSource) {
    const nodes = this.db.prepare("SELECT id,parent FROM nodes WHERE source=? AND generation=? AND offset<=? ORDER BY offset").all(source.id, source.generation, source.offset) as { id: string; parent: string | null }[];
    const parents = new Map(nodes.map(node => [node.id, node.parent]));
    const branch = new Set<string>();
    let next = source.state.leaf;
    while (next) {
      if (branch.has(next)) { source.issues.push("native_branch_cycle"); source.usable = false; break; }
      if (!parents.has(next)) { source.issues.push("native_branch_parent_missing"); break; }
      branch.add(next);
      next = parents.get(next) ?? null;
    }
    this.db.prepare("UPDATE records SET active=0 WHERE source=? AND generation=?").run(source.id, source.generation);
    const select = this.db.prepare("UPDATE records SET active=1 WHERE source=? AND generation=? AND nodeId=?");
    for (const id of branch) select.run(source.id, source.generation, id);
  }

  search(query: SessionSearchQuery & { repositoryId?: string }, coverage: SessionSearchStatus): SessionSearchResponse {
    const level = query.level ?? "chat", terms = [...new Set(query.query.normalize("NFKC").trim().split(/\s+/u))];
    if (!terms.length || terms.length > 12) throw new Error("session_search_query_invalid");
    const columns = level === "chat" ? ["chat"] : level === "work" ? ["chat", "act"] : ["chat", "act", "output"];
    const long = terms.filter(term => [...term].length >= 3), short = terms.filter(term => [...term].length < 3);
    const args: (string | number)[] = [];
    const where = ["s.usable=1", "r.active=1", "r.kind<>'context'", "r.generation=s.generation", "r.endOffset<=s.offset",
      "NOT EXISTS(SELECT 1 FROM records newer WHERE newer.source=r.source AND newer.generation=r.generation AND newer.nativeId=r.nativeId AND newer.endOffset>r.endOffset AND newer.endOffset<=s.offset)"];
    if (long.length) { where.push("search_fts MATCH ?"); args.push(`{${columns.join(" ")}} : (${long.map(term => '"' + term.replaceAll('"','""') + '"').join(" AND ")})`); }
    for (const term of short) {
      where.push(`(${columns.map(column => `c.${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
      for (const _ of columns) { void _; args.push(`%${term.replace(/[\\%_]/g, "\\$&")}%`); }
    }
    if (level === "chat") where.push("r.kind IN ('user','assistant')");
    else if (level === "work") where.push("r.kind IN ('user','assistant','request','file_change')");
    if (!query.allProjects) { where.push("s.repositoryId=?"); args.push(query.repositoryId ?? ""); }
    if (query.provider) { where.push("s.provider=?"); args.push(query.provider); }
    if (!query.includeOtherOrigins) where.push("s.origin='interactive'");
    // Match the parser's UTC millisecond representation before comparing TEXT timestamps.
    const from = query.from ? new Date(query.from).toISOString() : undefined;
    const to = query.to ? new Date(query.to).toISOString() : undefined;
    if (from) { where.push("r.occurredAt>=?"); args.push(from); }
    if (to) { where.push("r.occurredAt<?"); args.push(to); }
    const fingerprint = searchHash(JSON.stringify({ ...query, from, to, cursor: undefined, noUpdate: undefined }));
    let offset = 0;
    if (query.cursor) {
      let cursor: { generation: number; fingerprint: string; offset: number };
      try { cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString()); }
      catch { throw new Error("session_search_cursor_changed"); }
      if (!cursor) throw new Error("session_search_cursor_changed");
      if (cursor.generation !== coverage.generation || cursor.fingerprint !== fingerprint || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0)
        throw new Error("session_search_cursor_changed");
      offset = cursor.offset;
    }
    const score = long.length ? "bm25(search_fts,1.0,0.5,0.3)" : "0";
    const rows = this.db.prepare(`SELECT r.*,s.threadId,s.provider,s.cwd,s.title,s.origin,s.repositoryId,
      substr(c.chat||c.act||c.output,1,600) AS snippet,${score} AS score
      FROM ${long.length ? "search_fts JOIN chunks c ON c.id=search_fts.rowid" : "chunks c"}
      JOIN records r ON r.id=c.recordId JOIN sources s ON s.id=r.source
      WHERE ${where.join(" AND ")} ORDER BY score,r.occurredAt DESC,r.id LIMIT 2001`).all(...args) as HitRow[];
    const seen = new Set<string>();
    const grouped = rows.filter(row => {
      const key = `${row.provider}:${row.threadId}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    const limit = query.limit ?? 20;
    const selected = grouped.slice(offset, offset + limit);
    return { query: query.query, level, hits: selected.map(row => this.hit(row)),
      nextCursor: grouped.length > offset + limit ? Buffer.from(JSON.stringify({ generation: coverage.generation, fingerprint, offset: offset + limit })).toString("base64url") : null,
      partial: rows.length > 2000 || coverage.state !== "ready" || coverage.sources.some(s => s.status !== "ready"), coverage };
  }

  hit(row: HitRow, text?: string): SessionSearchHit {
    return { id: row.id, sessionId: row.source, threadId: row.threadId, provider: row.provider,
      projectPath: row.cwd, repositoryId: row.repositoryId, title: row.title || row.threadId,
      origin: row.origin, kind: row.kind, occurredAt: row.occurredAt, text: text ?? row.snippet ?? this.text(row.id),
      callId: row.callId, toolName: row.toolName, location: JSON.parse(row.location) as NativeRecordLocation };
  }
  text(recordId: string): string {
    const chunks = this.db.prepare("SELECT chat||act||output AS text FROM chunks WHERE recordId=? ORDER BY id").all(recordId) as { text: string }[];
    return chunks.map((chunk, i) => i ? chunk.text.slice(200) : chunk.text).join("").slice(0, 32_000);
  }
  records(id: string): { target: HitRow; context: HitRow[]; paired: HitRow[]; truncated: boolean } {
    const columns = "r.*,s.threadId,s.provider,s.cwd,s.title,s.origin,s.repositoryId";
    const valid = "r.source=s.id AND s.usable=1 AND r.generation=s.generation AND r.endOffset<=s.offset AND r.active=1 AND NOT EXISTS(SELECT 1 FROM records newer WHERE newer.source=r.source AND newer.generation=r.generation AND newer.nativeId=r.nativeId AND newer.endOffset>r.endOffset AND newer.endOffset<=s.offset)";
    const target = this.db.prepare(`SELECT ${columns} FROM records r JOIN sources s ON ${valid} WHERE r.id=?`).get(id) as HitRow | undefined;
    if (!target) throw new Error("session_search_record_unavailable");
    const rows = this.db.prepare(`SELECT ${columns} FROM records r JOIN sources s ON ${valid} WHERE r.source=? AND r.kind<>'context'
      ORDER BY abs(r.endOffset-?) LIMIT 13`).all(target.source, target.endOffset) as HitRow[];
    const paired = target.callId ? this.db.prepare(`SELECT ${columns} FROM records r JOIN sources s ON ${valid}
      WHERE r.source=? AND r.callId=? AND r.kind IN ('request','result') ORDER BY r.endOffset LIMIT 9`).all(target.source, target.callId) as HitRow[] : [];
    return { target, context: rows.slice(0, 12).sort((a,b) => a.endOffset-b.endOffset), paired: paired.slice(0, 8), truncated: rows.length > 12 || paired.length > 8 };
  }
  close() { this.db.close(); }
}
