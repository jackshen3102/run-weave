import Database from "better-sqlite3";
import type {
  EfficiencyFinding,
  EfficiencyMeasurement,
} from "@runweave/shared/execution-efficiency";

const SCHEMA_VERSION = 1;

export function migrateExecutionEfficiencyStore(
  database: Database.Database,
): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS efficiency_meta(version INTEGER NOT NULL);
     INSERT INTO efficiency_meta(version)
       SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM efficiency_meta);`,
  );
  const version = Number(
    (database.prepare("SELECT version FROM efficiency_meta LIMIT 1").get() as {
      version: number;
    }).version,
  );
  if (version > SCHEMA_VERSION) throw new Error("efficiency_schema_too_new");
  if (version < 1) {
    database.transaction(() => {
      database.exec(
        `CREATE TABLE efficiency_bindings(
           project_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision INTEGER NOT NULL, payload_json TEXT NOT NULL
         );
         CREATE TABLE efficiency_observations(
           id TEXT PRIMARY KEY, project_id TEXT NOT NULL, repository_id TEXT NOT NULL,
           dimension TEXT NOT NULL, observed_at TEXT NOT NULL, payload_json TEXT NOT NULL
         );
         CREATE INDEX efficiency_observations_project ON efficiency_observations(project_id, observed_at);
         CREATE TABLE efficiency_checkpoints(
           repository_id TEXT NOT NULL, session_id TEXT NOT NULL, payload_json TEXT NOT NULL,
           PRIMARY KEY(repository_id, session_id)
         );
         CREATE TABLE efficiency_analysis_runs(
           id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
           scheduled_run_id TEXT NOT NULL, thread_id TEXT, status TEXT NOT NULL,
           created_at TEXT NOT NULL, payload_json TEXT NOT NULL, candidates_json TEXT NOT NULL
         );
         CREATE INDEX efficiency_analysis_project ON efficiency_analysis_runs(project_id, created_at DESC);
         CREATE TABLE efficiency_findings(
           id TEXT PRIMARY KEY, project_id TEXT NOT NULL, dimension TEXT NOT NULL,
           status TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
           analysis_id TEXT, payload_json TEXT NOT NULL
         );
         CREATE INDEX efficiency_findings_project ON efficiency_findings(project_id, dimension, status, updated_at DESC);
         CREATE TABLE efficiency_finding_observations(
           finding_id TEXT NOT NULL REFERENCES efficiency_findings(id),
           observation_id TEXT NOT NULL REFERENCES efficiency_observations(id),
           PRIMARY KEY(finding_id, observation_id)
         );
         CREATE TABLE efficiency_finding_events(
           id TEXT PRIMARY KEY, finding_id TEXT NOT NULL REFERENCES efficiency_findings(id),
           action TEXT NOT NULL, pending_question INTEGER NOT NULL DEFAULT 0,
           created_at TEXT NOT NULL, payload_json TEXT NOT NULL
         );
         CREATE INDEX efficiency_events_finding ON efficiency_finding_events(finding_id, created_at);
         CREATE TABLE efficiency_decisions(
           fingerprint TEXT NOT NULL, policy_version TEXT NOT NULL, payload_json TEXT NOT NULL,
           PRIMARY KEY(fingerprint, policy_version)
         );
         CREATE TABLE efficiency_idempotency(
           scope TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL,
           response_json TEXT NOT NULL, created_at TEXT NOT NULL,
           PRIMARY KEY(scope, key)
         );
         UPDATE efficiency_meta SET version = 1;`,
      );
    })();
  }
}

export function unavailableMeasurement(
  dimension: EfficiencyFinding["dimension"],
): EfficiencyMeasurement {
  if (dimension === "tokens") {
    return {
      kind: "token-windows",
      samples: 0,
      occurrences: 0,
      input: null,
      cachedInput: null,
      nonCachedInput: null,
      cacheWriteInput: null,
      output: null,
      reasoningOutput: null,
      total: null,
      model: null,
      serviceTier: null,
      boundary: "测量不可用",
      callIds: [],
      attribution: "mixed",
    };
  }
  return {
    kind: "call-interval",
    seconds: null,
    targetSeconds: null,
    sampleCount: 0,
    boundary: "测量不可用",
    intervalCount: 0,
    percentile95Seconds: null,
  };
}
