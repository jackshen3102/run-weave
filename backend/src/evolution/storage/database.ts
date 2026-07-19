import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  CandidateAsset,
  EvolutionScopePolicy,
  RuntimeTraceEvent,
  RuntimeTraceSummary,
} from "@runweave/shared/evolution";

export class EvolutionActivationDatabase {
  private readonly database: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS evolution_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    const minimumWriterVersion = this.database
      .prepare("SELECT value FROM evolution_metadata WHERE key = ?")
      .get("minimumWriterVersion") as { value: string } | undefined;
    if (minimumWriterVersion) {
      const parsedMinimumWriterVersion = Number(minimumWriterVersion.value);
      if (
        !Number.isInteger(parsedMinimumWriterVersion) ||
        parsedMinimumWriterVersion > 1
      ) {
        throw new Error("evolution_schema_incompatible");
      }
    }
    this.database
      .transaction(() => {
        this.database.exec(`
        CREATE TABLE IF NOT EXISTS candidate_asset_revisions (
          revision_id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL,
          learning_scope_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS candidate_asset_scope_idx
          ON candidate_asset_revisions (learning_scope_id, asset_id, updated_at);
        CREATE TABLE IF NOT EXISTS evolution_policies (
          learning_scope_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runtime_traces (
          trace_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS runtime_trace_run_idx
          ON runtime_traces (run_id, created_at);
        CREATE TABLE IF NOT EXISTS runtime_trace_events (
          event_id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL REFERENCES runtime_traces(trace_id) ON DELETE CASCADE,
          at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS runtime_trace_event_trace_idx
          ON runtime_trace_events (trace_id, at);
      `);
        this.database
          .prepare(
            "INSERT OR IGNORE INTO evolution_metadata (key, value) VALUES (?, ?)",
          )
          .run("schemaVersion", "1");
        this.database
          .prepare(
            "INSERT OR IGNORE INTO evolution_metadata (key, value) VALUES (?, ?)",
          )
          .run("minimumWriterVersion", "1");
      })
      .immediate();
  }

  listCandidates(): CandidateAsset[] {
    const rows = this.database
      .prepare(
        `SELECT payload_json
         FROM (
           SELECT payload_json,
                  ROW_NUMBER() OVER (
                    PARTITION BY asset_id
                    ORDER BY updated_at DESC, rowid DESC
                  ) AS current_revision
           FROM candidate_asset_revisions
         )
         WHERE current_revision = 1`,
      )
      .all() as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as CandidateAsset);
  }

  putCandidate(candidate: CandidateAsset): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO candidate_asset_revisions
          (revision_id, asset_id, learning_scope_id, updated_at, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.revisionId,
        candidate.assetId,
        candidate.learningScopeId,
        candidate.updatedAt,
        JSON.stringify(candidate),
      );
  }

  getPolicy(learningScopeId: string): EvolutionScopePolicy | null {
    const row = this.database
      .prepare(
        "SELECT payload_json FROM evolution_policies WHERE learning_scope_id = ?",
      )
      .get(learningScopeId) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as EvolutionScopePolicy) : null;
  }

  putPolicy(policy: EvolutionScopePolicy): void {
    const result = this.database
      .prepare(
        `INSERT INTO evolution_policies (learning_scope_id, revision, payload_json)
         VALUES (?, ?, ?)
         ON CONFLICT(learning_scope_id) DO UPDATE SET
           revision = excluded.revision,
           payload_json = excluded.payload_json
         WHERE excluded.revision > evolution_policies.revision`,
      )
      .run(policy.learningScopeId, policy.revision, JSON.stringify(policy));
    if (result.changes !== 1) {
      throw new Error("evolution_policy_revision_conflict");
    }
  }

  putRuntimeTrace(trace: RuntimeTraceSummary): void {
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT OR IGNORE INTO runtime_traces
            (trace_id, run_id, created_at, payload_json)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          trace.traceId,
          trace.runId,
          trace.createdAt,
          JSON.stringify({ ...trace, events: [] }),
        );
      for (const event of trace.events) {
        this.appendRuntimeTraceEvent(event);
      }
    })();
  }

  appendRuntimeTraceEvent(event: RuntimeTraceEvent): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO runtime_trace_events
          (event_id, trace_id, at, payload_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(event.eventId, event.traceId, event.at, JSON.stringify(event));
  }

  getRuntimeTrace(traceId: string): RuntimeTraceSummary | null {
    const row = this.database
      .prepare("SELECT payload_json FROM runtime_traces WHERE trace_id = ?")
      .get(traceId) as { payload_json: string } | undefined;
    if (!row) return null;
    const trace = JSON.parse(row.payload_json) as RuntimeTraceSummary;
    return { ...trace, events: this.listEvents(traceId) };
  }

  listRuntimeTraces(runId: string): RuntimeTraceSummary[] {
    const rows = this.database
      .prepare(
        "SELECT trace_id FROM runtime_traces WHERE run_id = ? ORDER BY created_at",
      )
      .all(runId) as Array<{ trace_id: string }>;
    return rows.flatMap((row) => {
      const trace = this.getRuntimeTrace(row.trace_id);
      return trace ? [trace] : [];
    });
  }

  private listEvents(traceId: string): RuntimeTraceEvent[] {
    const rows = this.database
      .prepare(
        `SELECT payload_json FROM runtime_trace_events
         WHERE trace_id = ? ORDER BY at, rowid`,
      )
      .all(traceId) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as RuntimeTraceEvent);
  }

  integrity(): boolean {
    const result = this.database.pragma("quick_check") as Array<{
      quick_check: string;
    }>;
    return result.every((row) => row.quick_check === "ok");
  }

  close(): void {
    this.database.close();
  }
}
