import Database from "better-sqlite3";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { QUALITY_LIMITS, qualityCanonical, type QualityBatch, type QualityContextRequest, type QualityEvidence, type QualityLedger, type QualityLedgerCommit, type QualityRange } from "@runweave/shared/quality-workflow";

export class QualityError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details?: unknown) { super(code); }
}
interface Stream { sourceId: string; streamId: string; client: QualityBatch["client"]; ackThrough: number; lastReceivedAt: string; droppedRanges: QualityRange[] }
interface State { storageBlocked?: boolean; epoch: string; backendId: string; cleanedThrough: number; streams: Stream[]; gaps: { kind: string; at: string; sourceId?: string }[]; offsets: Record<string, { identity: string; offset: number; missing?: boolean }>; ledger: QualityLedger }
interface Row { receiveId: number; body: string; hash: string; bytes: number }
export interface LogCheckpoint { key: string; identity: string; offset: number; gap?: string; missing?: boolean }
export class QualityDatabase {
  private db: Database.Database;
  constructor(file: string, private backendId: string, private maxBytes: number = QUALITY_LIMITS.storageBytes, private retentionDays: number = QUALITY_LIMITS.retentionDays) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    chmodSync(file, 0o600);
    const version = this.db.pragma("user_version", { simple: true });
    if (version !== 0 && version !== 1) { this.db.close(); throw new QualityError(503, "unsupported_quality_schema"); }
    this.db.pragma("journal_mode = WAL"); this.db.pragma("synchronous = FULL"); this.db.pragma("busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (receiveId INTEGER PRIMARY KEY AUTOINCREMENT, sourceId TEXT NOT NULL, streamId TEXT NOT NULL, seq INTEGER NOT NULL, receivedAt TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(sourceId,streamId,seq));
      CREATE INDEX IF NOT EXISTS events_operation ON events(sourceId, json_extract(body,'$.launchId'), json_extract(body,'$.action'), json_extract(body,'$.operationId'), receiveId);
      CREATE TABLE IF NOT EXISTS commits (key TEXT PRIMARY KEY, hash TEXT NOT NULL, revision INTEGER NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fingerprints (key TEXT PRIMARY KEY, hash TEXT NOT NULL, at TEXT NOT NULL);`);
    this.db.pragma("user_version = 1");
    if (!this.db.prepare("SELECT 1 FROM state WHERE id=1").get()) this.save({ storageBlocked: false, epoch: randomUUID(), backendId, cleanedThrough: 0, streams: [], gaps: [], offsets: {}, ledger: {
      schemaVersion: 1, revision: 0, issues: [], readCursor: null, analysisCursor: null, pending: [], lease: null, reports: [],
    } });
    if (this.state().backendId !== backendId) { this.db.close(); throw new QualityError(409, "backend_mismatch"); }
  }
  private state(): State { return JSON.parse((this.db.prepare("SELECT body FROM state WHERE id=1").get() as { body: string }).body); }
  private save(state: State) { this.db.prepare("INSERT OR REPLACE INTO state VALUES(1,?)").run(JSON.stringify(state)); }
  private size(state: State = this.state()) {
    const indexedBytes = (this.db.prepare("SELECT (SELECT coalesce(sum(bytes),0) FROM events) + (SELECT coalesce(sum(length(key)+length(hash)+length(at)),0) FROM fingerprints) + (SELECT coalesce(sum(length(key)+length(hash)+length(at)+8),0) FROM commits) AS n").get() as { n: number }).n;
    return indexedBytes + Buffer.byteLength(JSON.stringify(state));
  }
  private receivedSequences(sourceId: string, streamId: string, after: number): number[] {
    const prefix = `${sourceId}:${streamId}:`;
    // Receipt fingerprints remain authoritative even when retention removed an event body.
    return (this.db.prepare("SELECT cast(substr(key, ?) AS INTEGER) AS seq FROM fingerprints WHERE key>=? AND key<? AND cast(substr(key, ?) AS INTEGER)>? ORDER BY seq")
      .all(prefix.length + 1, prefix, prefix + "\uffff", prefix.length + 1, after) as { seq: number }[]).map(row => row.seq);
  }
  private latest() { return (this.db.prepare("SELECT coalesce(max(receiveId),0) AS n FROM events").get() as { n: number }).n; }
  private prune(state: State, reserve = 0) {
    const pinned = new Set([...state.ledger.issues.filter(i => i.status !== "closed").flatMap(i => i.evidenceIds), ...state.ledger.pending.map(e => e.receiveId)]);
    const cutoff = new Date(Date.now() - this.retentionDays * 86400_000).toISOString();
    this.db.prepare("DELETE FROM fingerprints WHERE at<? AND key NOT IN (SELECT sourceId||':'||streamId||':'||seq FROM events)").run(cutoff);
    this.db.prepare("DELETE FROM commits WHERE at<?").run(cutoff);
    let size = this.size(state);
    for (const row of this.db.prepare("SELECT receiveId,bytes,receivedAt FROM events ORDER BY receiveId").all() as { receiveId: number; bytes: number; receivedAt: string }[]) {
      if (pinned.has(row.receiveId)) continue;
      if (row.receivedAt >= cutoff && size + reserve <= this.maxBytes) continue;
      this.db.prepare("DELETE FROM events WHERE receiveId=?").run(row.receiveId);
      const previousBoundaryBytes = String(state.cleanedThrough).length;
      state.cleanedThrough = Math.max(state.cleanedThrough, row.receiveId);
      size -= row.bytes;
      size += String(state.cleanedThrough).length - previousBoundaryBytes;
    }
    return this.size(state) + reserve <= this.maxBytes;
  }
  ingest(batch: QualityBatch, projects: Record<string, string | null>, checkpoint?: LogCheckpoint) {
    try { return this.db.transaction(() => {
      const state = this.state(); const receivedAt = new Date().toISOString();
      let stream = state.streams.find(s => s.sourceId === batch.sourceId && s.streamId === batch.streamId);
      if (!stream && state.streams.length >= 1000) throw new QualityError(503, "source_capacity_reached");
      if (!stream) { stream = { sourceId: batch.sourceId, streamId: batch.streamId, client: batch.client, ackThrough: 0, lastReceivedAt: receivedAt, droppedRanges: [] }; state.streams.push(stream); }
      if (stream.client !== batch.client) throw new QualityError(409, "source_conflict");
      let duplicateCount = 0;
      const unique = new Map<number, QualityBatch["events"][number]>();
      for (const event of batch.events) {
        const prior = unique.get(event.seq);
        if (prior && qualityCanonical(prior) !== qualityCanonical(event)) throw new QualityError(409, "sequence_conflict");
        if (prior) { duplicateCount++; continue; } unique.set(event.seq, event);
      }
      const incoming: { event: QualityBatch["events"][number]; hash: string; body: string }[] = [];
      for (const event of unique.values()) {
        const hash = createHash("sha256").update(qualityCanonical(event)).digest("hex");
        const key = `${batch.sourceId}:${batch.streamId}:${event.seq}`;
        const old = this.db.prepare("SELECT hash FROM fingerprints WHERE key=?").get(key) as { hash: string } | undefined;
        if (old) { if (old.hash !== hash) throw new QualityError(409, "sequence_conflict"); duplicateCount++; continue; }
        if (event.seq <= stream.ackThrough || stream.droppedRanges.some(r => r.from <= event.seq && r.through >= event.seq)) throw new QualityError(409, "sequence_dropped");
        const body = JSON.stringify({ ...event, receivedAt, backendId: this.backendId, sourceId: batch.sourceId, streamId: batch.streamId, client: batch.client, projectId: projects[event.terminalSessionId ?? ""] ?? null });
        incoming.push({ event, hash, body });
      }
      const received = this.receivedSequences(batch.sourceId, batch.streamId, stream.ackThrough);
      for (const range of batch.droppedRanges) {
        if (incoming.some(e => e.event.seq >= range.from && e.event.seq <= range.through)) throw new QualityError(409, "range_conflict");
        // A lost receipt can make a client evict events already persisted here. Only
        // the still-missing portions are gaps; never overwrite received evidence.
        let from = Math.max(range.from, stream.ackThrough + 1);
        for (const seq of received) {
          if (seq < from) continue;
          if (seq > range.through) break;
          if (seq > from) stream.droppedRanges.push({ ...range, from, through: seq - 1 });
          from = seq + 1;
        }
        if (from <= range.through) stream.droppedRanges.push({ ...range, from });
      }
      stream.droppedRanges = mergeRanges(stream.droppedRanges);
      const seqs = [...received, ...incoming.map(item => item.event.seq)].sort((a, b) => a - b);
      let changed = true;
      while (changed) {
        changed = false;
        const gap = stream.droppedRanges.find(r => r.from <= stream!.ackThrough + 1 && r.through > stream!.ackThrough);
        if (gap) { stream.ackThrough = gap.through; changed = true; }
        for (const seq of seqs) {
          if (seq <= stream.ackThrough) continue;
          if (seq !== stream.ackThrough + 1) break;
          stream.ackThrough = seq; changed = true;
        }
      }
      stream.lastReceivedAt = receivedAt;
      if (checkpoint) { state.offsets[checkpoint.key] = { identity: checkpoint.identity, offset: checkpoint.offset, ...(checkpoint.missing ? { missing: true } : {}) }; if (checkpoint.gap) state.gaps.push({ kind: checkpoint.gap, at: receivedAt }); }
      state.storageBlocked = false; state.gaps = state.gaps.slice(-1000);
      const reserve = incoming.reduce((bytes, item) => bytes + Buffer.byteLength(item.body) + Buffer.byteLength(`${batch.sourceId}:${batch.streamId}:${item.event.seq}`) + item.hash.length + receivedAt.length, 0);
      if (!this.prune(state, reserve)) throw new QualityError(503, "storage_full");
      for (const { event, hash, body } of incoming) {
        this.db.prepare("INSERT INTO events(sourceId,streamId,seq,receivedAt,hash,bytes,body) VALUES(?,?,?,?,?,?,?)").run(batch.sourceId, batch.streamId, event.seq, receivedAt, hash, Buffer.byteLength(body), body);
        this.db.prepare("INSERT INTO fingerprints VALUES(?,?,?)").run(`${batch.sourceId}:${batch.streamId}:${event.seq}`, hash, receivedAt);
      }
      this.save(state);
      return { ackThrough: stream.ackThrough, acceptedCount: incoming.length, duplicateCount, receivedAt };
    })(); } catch (error) {
      if (error instanceof QualityError && error.code === "storage_full") {
        const state = this.state(); state.storageBlocked = true;
        if (this.size(state) <= this.maxBytes) this.save(state);
      }
      throw error;
    }
  }
  private cursor(state: State, after: number, upper = 0) { return Buffer.from(JSON.stringify({ epoch: state.epoch, after, upper })).toString("base64url"); }
  private parseCursor(state: State, cursor?: string, allowPruned = false) {
    if (!cursor) return { after: 0, upper: 0 };
    let value: { epoch: string; after: number; upper: number };
    try { value = JSON.parse(Buffer.from(cursor, "base64url").toString()); } catch { throw new QualityError(400, "invalid_cursor"); }
    if (!value || !Number.isSafeInteger(value.after) || value.after < 0 || !Number.isSafeInteger(value.upper) || value.upper < 0) throw new QualityError(400, "invalid_cursor");
    if (value.epoch !== state.epoch || !allowPruned && value.after < state.cleanedThrough) throw new QualityError(409, "cursor_expired", { earliestCursor: this.cursor(state, state.cleanedThrough), cleanedThrough: state.cleanedThrough });
    if (value.after > this.latest() && value.after > state.cleanedThrough || value.upper && value.upper < value.after) throw new QualityError(400, "invalid_cursor");
    return value;
  }
  events(cursor?: string, limit = 200) {
    this.db.transaction(() => {
      const state = this.state();
      // Reads remain available when pinned evidence exhausts the write budget.
      // Retention can still clean unpinned data, but capacity is a write boundary.
      this.prune(state); this.save(state);
    })();
    return this.db.transaction(() => {
      const state = this.state();
      if (!cursor && state.cleanedThrough) throw new QualityError(409, "cursor_expired", { earliestCursor: this.cursor(state, state.cleanedThrough), cleanedThrough: state.cleanedThrough });
      const parsed = this.parseCursor(state, cursor); const upper = parsed.upper || Math.max(this.latest(), state.cleanedThrough);
      const rows = this.db.prepare("SELECT receiveId,body FROM events WHERE receiveId>? AND receiveId<=? ORDER BY receiveId LIMIT ?").all(parsed.after, upper, limit + 1) as Row[];
      const hasMore = rows.length > limit;
      const events = rows.slice(0, limit).map(r => ({ ...JSON.parse(r.body), receiveId: r.receiveId })) as QualityEvidence[];
      const after = hasMore ? events.at(-1)!.receiveId : upper;
      return { schemaVersion: 1, epoch: state.epoch, events, nextCursor: this.cursor(state, after, hasMore ? upper : 0), hasMore, snapshotUpper: upper };
    })();
  }
  context(request: QualityContextRequest) {
    return this.db.transaction(() => {
      const state = this.state();
      if (request.readCursor !== state.ledger.readCursor) throw new QualityError(409, "context_checkpoint_changed");
      // Historical context may straddle retention gaps; return retained rows and the boundary explicitly.
      const through = this.parseCursor(state, request.readCursor, true).after;
      const after = request.after ?? 0; const limit = request.limit ?? 1000;
      if (after > through) throw new QualityError(400, "invalid_context_range");
      const operations = [...new Map(request.operations.map(operation => [qualityCanonical(operation), operation])).values()];
      const rows = this.db.prepare(`SELECT e.receiveId,e.body FROM json_each(?) AS operation JOIN events AS e
        ON e.sourceId=json_extract(operation.value,'$.sourceId')
        AND json_extract(e.body,'$.launchId')=json_extract(operation.value,'$.launchId')
        AND json_extract(e.body,'$.action')=json_extract(operation.value,'$.action')
        AND json_extract(e.body,'$.operationId')=json_extract(operation.value,'$.operationId')
        WHERE e.receiveId>? AND e.receiveId<=? ORDER BY e.receiveId LIMIT ?`)
        .all(JSON.stringify(operations), after, through, limit + 1) as Row[];
      const events = rows.slice(0, limit).map(row => ({ ...JSON.parse(row.body), receiveId: row.receiveId })) as QualityEvidence[];
      return { schemaVersion: 1, events, through, cleanedThrough: state.cleanedThrough, nextAfter: rows.length > limit ? events.at(-1)!.receiveId : null };
    })();
  }
  coverage() {
    const state = this.state(); const bytes = this.size();
    return { schemaVersion: 1, backendId: this.backendId, epoch: state.epoch, earliestReceiveId: (this.db.prepare("SELECT coalesce(min(receiveId),0) n FROM events").get() as { n: number }).n, latestReceiveId: Math.max(this.latest(), state.cleanedThrough), cleanedThrough: state.cleanedThrough, earliestCursor: this.cursor(state, state.cleanedThrough),
      storageBytes: bytes, storageState: state.storageBlocked || bytes >= this.maxBytes ? "storage_full" : "available", sources: state.streams, gaps: state.gaps, clientQueueState: "unknown", offlineCoverage: "unknown",
      logSources: [{ kind: "backend", state: "configured" }, { kind: "desktop", state: "unconfigured" }] };
  }
  ledger(issueId?: string) { const ledger = this.state().ledger; return issueId ? { ...ledger, issues: ledger.issues.filter(i => i.issueId === issueId) } : ledger; }
  offsets() { return this.state().offsets; }
  commit(request: QualityLedgerCommit) {
    return this.db.transaction(() => {
      const state = this.state(); const ledger = state.ledger;
      const hash = createHash("sha256").update(qualityCanonical(request)).digest("hex");
      const key = `${request.runKey}:${request.commitKey}`;
      const previous = this.db.prepare("SELECT hash,revision FROM commits WHERE key=?").get(key) as { hash: string; revision: number } | undefined;
      if (previous) { if (previous.hash !== hash) throw new QualityError(409, "commit_conflict"); return { revision: previous.revision, replayed: true }; }
      if (ledger.revision !== request.expectedRevision) throw new QualityError(409, "revision_conflict");
      const now = new Date().toISOString();
      if (ledger.lease && ledger.lease.runKey !== request.runKey && ledger.lease.expiresAt > now) throw new QualityError(409, "ledger_busy");
      if (request.phase !== "acquire" && request.phase !== "confirm_close" && ledger.lease?.runKey !== request.runKey) throw new QualityError(409, "lease_required");
      if (request.confirmedIssueIds && request.phase !== "confirm_close") throw new QualityError(400, "invalid_confirmation_phase");
      if (request.phase === "confirm_close") {
        if (!request.confirmedIssueIds?.length || !request.summary || request.pending || request.issues || request.readCursor || request.analysisCursor) throw new QualityError(400, "invalid_confirmation");
        for (const id of request.confirmedIssueIds) {
          const issue = ledger.issues.find(item => item.issueId === id);
          if (!issue || issue.status !== "awaiting_confirmation" || !issue.fixVersion || !issue.verification.length) throw new QualityError(409, "issue_not_ready_for_confirmation");
          issue.status = "closed";
        }
      } else if (request.phase === "acquire") {
        if (request.pending || request.issues || request.readCursor || request.analysisCursor) throw new QualityError(400, "invalid_acquire");
      } else if (request.phase === "recovery") {
        if (ledger.pending.length || request.pending || request.issues || request.analysisCursor || request.readCursor !== this.cursor(state, state.cleanedThrough) || !request.summary) throw new QualityError(400, "invalid_recovery");
        state.gaps.push({ kind: "analysis_cursor_expired", at: now });
        ledger.readCursor = request.readCursor;
      } else if (request.phase === "checkpoint") {
        if (request.issues || request.analysisCursor || ledger.pending.length || !request.readCursor || !request.pending) throw new QualityError(400, "invalid_checkpoint");
        const next = this.parseCursor(state, request.readCursor); const prior = this.parseCursor(state, ledger.readCursor ?? undefined);
        if (next.after < prior.after) throw new QualityError(409, "watermark_regression");
        const expected = this.db.prepare("SELECT receiveId,body FROM events WHERE receiveId>? AND receiveId<=? ORDER BY receiveId").all(prior.after, next.after) as Row[];
        const actual = expected.map(r => ({ ...JSON.parse(r.body), receiveId: r.receiveId }));
        if (qualityCanonical(actual) !== qualityCanonical(request.pending)) throw new QualityError(409, "checkpoint_mismatch");
        ledger.pending = request.pending; ledger.readCursor = request.readCursor;
      } else if (request.phase === "analysis") {
        if (!request.pending || request.readCursor || request.analysisCursor && request.analysisCursor !== ledger.readCursor) throw new QualityError(400, "invalid_analysis");
        if (request.pending.length && request.analysisCursor) throw new QualityError(400, "pending_analysis_watermark");
        for (const event of request.pending) if (!ledger.pending.some(e => qualityCanonical(e) === qualityCanonical(event))) throw new QualityError(409, "pending_mismatch");
        for (const issue of request.issues ?? []) {
          if (issue.status === "closed") throw new QualityError(400, "user_confirmation_required");
          const old = ledger.issues.find(i => i.issueId === issue.issueId);
          if (old && (old.firstAt !== issue.firstAt || old.evidenceIds.some(id => !issue.evidenceIds.includes(id)))) throw new QualityError(409, "issue_history_missing");
          if (old && old.groupKey !== issue.groupKey || ledger.issues.some(i => i.groupKey === issue.groupKey && i.issueId !== issue.issueId)) throw new QualityError(409, "issue_identity_conflict");
          // Existing references remain historical facts after closed-issue retention. Only newly
          // added references require a live body; otherwise a legitimate recurrence cannot reopen.
          const historical = new Set(old?.evidenceIds ?? []);
          for (const id of issue.evidenceIds) if (!historical.has(id) && !this.db.prepare("SELECT 1 FROM events WHERE receiveId=?").get(id)) throw new QualityError(409, "evidence_expired");
          ledger.issues = [...ledger.issues.filter(i => i.issueId !== issue.issueId), issue];
        }
        ledger.pending = request.pending;
        if (request.analysisCursor) ledger.analysisCursor = request.analysisCursor;
      } else if (request.pending || request.issues || request.readCursor || request.analysisCursor) throw new QualityError(400, "invalid_release");
      ledger.lease = request.phase === "release" || request.phase === "confirm_close" ? null : { runKey: request.runKey, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
      if (request.summary) ledger.reports = [...ledger.reports, { runKey: request.runKey, at: now, summary: request.summary }].slice(-90);
      ledger.revision++;
      const commitBytes = Buffer.byteLength(key) + hash.length + now.length + 8;
      if (!this.prune(state, commitBytes)) throw new QualityError(503, "storage_full");
      this.save(state); this.db.prepare("INSERT INTO commits VALUES(?,?,?,?)").run(key, hash, ledger.revision, now);
      return { revision: ledger.revision, replayed: false };
    })();
  }
  close() { this.db.close(); }
}
function mergeRanges(ranges: QualityRange[]): QualityRange[] {
  const merged: QualityRange[] = [];
  for (const item of [...ranges].sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && item.from <= last.through + 1 && item.reason === last.reason) last.through = Math.max(last.through, item.through);
    else merged.push({ ...item });
  }
  return merged;
}
