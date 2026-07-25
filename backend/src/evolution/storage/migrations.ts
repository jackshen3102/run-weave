import type Database from "better-sqlite3";

const SCHEMA_VERSION = 5;
const MINIMUM_WRITER_VERSION = 1;

export function migrateEvolutionDatabase(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS evolution_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  assertCompatibleWriter(database);
  database
    .transaction(() => {
      database.exec(`
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
          trace_id TEXT NOT NULL
            REFERENCES runtime_traces(trace_id) ON DELETE CASCADE,
          at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS runtime_trace_event_trace_idx
          ON runtime_trace_events (trace_id, at);

        CREATE TABLE IF NOT EXISTS evolution_runs (
          run_id TEXT PRIMARY KEY,
          learning_scope_id TEXT NOT NULL,
          trigger_type TEXT NOT NULL,
          priority INTEGER NOT NULL,
          trigger_json TEXT NOT NULL,
          profile TEXT NOT NULL,
          provider_policy TEXT NOT NULL,
          budget_json TEXT NOT NULL,
          data_range_json TEXT NOT NULL,
          stage TEXT NOT NULL,
          outcome TEXT,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          started_at_ms INTEGER,
          completed_at_ms INTEGER,
          attempt INTEGER NOT NULL,
          owner_id TEXT,
          fencing_token INTEGER
        );
        CREATE INDEX IF NOT EXISTS evolution_run_queue_idx
          ON evolution_runs (stage, priority, created_at_ms);
        CREATE INDEX IF NOT EXISTS evolution_run_scope_idx
          ON evolution_runs (learning_scope_id, created_at_ms DESC);

        CREATE TABLE IF NOT EXISTS evolution_leases (
          lease_key TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          fencing_token INTEGER NOT NULL,
          acquired_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS evolution_schedules (
          schedule_id TEXT PRIMARY KEY,
          learning_scope_id TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS evolution_schedule_scope_idx
          ON evolution_schedules (learning_scope_id, updated_at_ms DESC);

        CREATE TABLE IF NOT EXISTS evolution_watermarks (
          learning_scope_id TEXT NOT NULL,
          source TEXT NOT NULL,
          value TEXT NOT NULL,
          run_id TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (learning_scope_id, source)
        );

        CREATE TABLE IF NOT EXISTS context_packs (
          context_pack_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL UNIQUE,
          learning_scope_id TEXT NOT NULL,
          digest TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          manifest_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS context_pack_scope_idx
          ON context_packs (learning_scope_id, created_at_ms DESC);
        CREATE INDEX IF NOT EXISTS context_pack_digest_idx
          ON context_packs (digest);

        CREATE TABLE IF NOT EXISTS context_pack_sources (
          context_pack_id TEXT NOT NULL
            REFERENCES context_packs(context_pack_id) ON DELETE CASCADE,
          source_id TEXT NOT NULL,
          source TEXT NOT NULL,
          boundary_json TEXT NOT NULL,
          PRIMARY KEY (context_pack_id, source_id)
        );
        CREATE TRIGGER IF NOT EXISTS context_packs_immutable_update
          BEFORE UPDATE ON context_packs
          BEGIN
            SELECT RAISE(ABORT, 'evolution_context_pack_immutable');
          END;
        CREATE TRIGGER IF NOT EXISTS context_pack_sources_immutable_update
          BEFORE UPDATE ON context_pack_sources
          BEGIN
            SELECT RAISE(ABORT, 'evolution_context_pack_source_immutable');
          END;

        CREATE TABLE IF NOT EXISTS trace_segments (
          segment_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          learning_scope_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS trace_segment_run_idx
          ON trace_segments (run_id, sequence);

        CREATE TABLE IF NOT EXISTS episodes (
          episode_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          learning_scope_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS episode_run_idx
          ON episodes (run_id, created_at);

        CREATE TABLE IF NOT EXISTS analysis_reports (
          report_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          role TEXT NOT NULL,
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS analysis_report_run_idx
          ON analysis_reports (run_id, attempt_number, created_at);

        CREATE TABLE IF NOT EXISTS evolution_run_attempts (
          attempt_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          role TEXT NOT NULL,
          provider TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS evolution_run_attempt_run_idx
          ON evolution_run_attempts (run_id, attempt_number, started_at);

        CREATE TABLE IF NOT EXISTS claims (
          claim_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          learning_scope_id TEXT NOT NULL,
          topic_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS claim_run_idx
          ON claims (run_id, topic_key);

        CREATE TABLE IF NOT EXISTS claim_novelty (
          claim_id TEXT PRIMARY KEY
            REFERENCES claims(claim_id) ON DELETE CASCADE,
          run_id TEXT NOT NULL,
          novelty TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS claim_novelty_run_idx
          ON claim_novelty (run_id, novelty);

        CREATE TABLE IF NOT EXISTS insights (
          insight_id TEXT PRIMARY KEY,
          learning_scope_id TEXT NOT NULL,
          topic_key TEXT NOT NULL,
          current_revision_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (learning_scope_id, topic_key)
        );
        CREATE INDEX IF NOT EXISTS insight_scope_idx
          ON insights (learning_scope_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS insight_revisions (
          revision_id TEXT PRIMARY KEY,
          insight_id TEXT NOT NULL
            REFERENCES insights(insight_id) ON DELETE CASCADE,
          run_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS insight_revision_insight_idx
          ON insight_revisions (insight_id, created_at);
        CREATE INDEX IF NOT EXISTS insight_revision_run_idx
          ON insight_revisions (run_id, created_at);

        CREATE TABLE IF NOT EXISTS contribution_edges (
          edge_id TEXT PRIMARY KEY,
          insight_revision_id TEXT NOT NULL
            REFERENCES insight_revisions(revision_id) ON DELETE CASCADE,
          evidence_id TEXT NOT NULL,
          availability TEXT NOT NULL,
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS contribution_edge_revision_idx
          ON contribution_edges (insight_revision_id, evidence_id);

        CREATE TRIGGER IF NOT EXISTS trace_segments_immutable_update
          BEFORE UPDATE ON trace_segments
          BEGIN
            SELECT RAISE(ABORT, 'evolution_trace_segment_immutable');
          END;
        CREATE TRIGGER IF NOT EXISTS episodes_immutable_update
          BEFORE UPDATE ON episodes
          BEGIN
            SELECT RAISE(ABORT, 'evolution_episode_immutable');
          END;
        CREATE TRIGGER IF NOT EXISTS analysis_reports_immutable_update
          BEFORE UPDATE ON analysis_reports
          BEGIN
            SELECT RAISE(ABORT, 'evolution_analysis_report_immutable');
          END;
        CREATE TRIGGER IF NOT EXISTS claims_immutable_update
          BEFORE UPDATE ON claims
          BEGIN
            SELECT RAISE(ABORT, 'evolution_claim_immutable');
          END;
        CREATE TRIGGER IF NOT EXISTS claim_novelty_immutable_update
          BEFORE UPDATE ON claim_novelty
          BEGIN
            SELECT RAISE(ABORT, 'evolution_claim_novelty_immutable');
          END;
        CREATE TRIGGER IF NOT EXISTS insight_revisions_immutable_update
          BEFORE UPDATE ON insight_revisions
          BEGIN
            SELECT RAISE(ABORT, 'evolution_insight_revision_immutable');
          END;
        CREATE TRIGGER IF NOT EXISTS contribution_edges_immutable_update
          BEFORE UPDATE ON contribution_edges
          BEGIN
            SELECT RAISE(ABORT, 'evolution_contribution_edge_immutable');
          END;
      `);
      database
        .prepare(
          `INSERT INTO evolution_metadata (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run("schemaVersion", String(SCHEMA_VERSION));
      database
        .prepare(
          "INSERT OR IGNORE INTO evolution_metadata (key, value) VALUES (?, ?)",
        )
        .run("minimumWriterVersion", String(MINIMUM_WRITER_VERSION));
    })
    .immediate();
}

function assertCompatibleWriter(database: Database.Database): void {
  const minimumWriterVersion = database
    .prepare("SELECT value FROM evolution_metadata WHERE key = ?")
    .get("minimumWriterVersion") as { value: string } | undefined;
  if (!minimumWriterVersion) return;
  const parsed = Number(minimumWriterVersion.value);
  if (!Number.isInteger(parsed) || parsed > MINIMUM_WRITER_VERSION) {
    throw new Error("evolution_schema_incompatible");
  }
}
