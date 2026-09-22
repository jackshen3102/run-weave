import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { initialSchemaSql } from "./migrations/001-initial-schema";
import { catchUpDataSql } from "./migrations/002-catch-up-data";

const migrations = [
  { version: 1, name: "initial-schema", sql: initialSchemaSql },
  { version: 2, name: "catch-up-data", sql: catchUpDataSql },
] as const;
export const SCHEDULED_TASK_SCHEMA_VERSION = 2;

/** The entire upgrade is atomic, including adoption of the unversioned legacy database. */
export function migrateScheduledTasks(database: Database.Database): void {
  database
    .transaction(() => {
      const version = database.pragma("user_version", {
        simple: true,
      }) as number;
      if (version > SCHEDULED_TASK_SCHEMA_VERSION)
        throw new Error("scheduled_tasks_schema_too_new");
      database.exec(`CREATE TABLE IF NOT EXISTS scheduled_schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
      const history = database
        .prepare(
          "SELECT version, name, checksum FROM scheduled_schema_migrations ORDER BY version",
        )
        .all() as Array<{ version: number; name: string; checksum: string }>;
      if (
        history.length !== version ||
        history.some((row, index) => {
          const migration = migrations[index];
          return (
            !migration ||
            row.version !== migration.version ||
            row.name !== migration.name ||
            row.checksum !== checksum(migration.sql)
          );
        })
      )
        throw new Error("scheduled_tasks_schema_history_mismatch");

      for (const migration of migrations) {
        if (migration.version <= version) continue;
        if (migration.version === 1) assertLegacySchema(database);
        try {
          if (migration.version === 2) assertMigrationInput(database);
          database.exec(migration.sql);
          if (migration.version === 2) assertCurrentData(database);
        } catch {
          // Do not include private payloads or SQL driver error details in the error.
          throw new Error("scheduled_tasks_schema_migration_failed");
        }
        database
          .prepare(
            "INSERT INTO scheduled_schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
          )
          .run(
            migration.version,
            migration.name,
            checksum(migration.sql),
            new Date().toISOString(),
          );
        database.pragma(`user_version = ${migration.version}`);
      }
    })
    .immediate();
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/** Adopt only the exact known legacy tables/indexes, never guess how to repair a foreign schema. */
function assertLegacySchema(database: Database.Database): void {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'scheduled_schema_migrations' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  if (!tables.length) return;
  const reference = new Database(":memory:");
  try {
    reference.exec(initialSchemaSql);
    const expected = reference
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    if (JSON.stringify(tables) !== JSON.stringify(expected))
      throw new Error("scheduled_tasks_schema_legacy_mismatch");
    for (const { name } of tables) {
      // Names were compared with the fixed baseline above before interpolation.
      const signature = (db: Database.Database) => ({
        columns: db.pragma(`table_info(${name})`),
        foreignKeys: db.pragma(`foreign_key_list(${name})`),
        indexes: db
          .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name",
          )
          .all(name),
      });
      if (
        JSON.stringify(signature(database)) !==
        JSON.stringify(signature(reference))
      )
        throw new Error("scheduled_tasks_schema_legacy_mismatch");
    }
  } finally {
    reference.close();
  }
}

function assertCurrentData(database: Database.Database): void {
  for (const [table, policyPath] of [
    ["scheduled_tasks", "$.misfirePolicy"],
    ["scheduled_runs", "$.snapshot.misfirePolicy"],
  ]) {
    const invalid = database
      .prepare(
        `SELECT 1 FROM ${table} WHERE (
      json_type(payload_json, '${policyPath}') = 'object' AND (
        json_extract(payload_json, '${policyPath}.mode') = 'skip' OR (
          json_extract(payload_json, '${policyPath}.mode') = 'catch-up-latest' AND
          json_type(payload_json, '${policyPath}.maxDelaySeconds') = 'integer' AND
          json_extract(payload_json, '${policyPath}.maxDelaySeconds') BETWEEN 3600 AND 604800 AND
          json_extract(payload_json, '${policyPath}.maxDelaySeconds') % 3600 = 0
        )
      )
    ) IS NOT TRUE LIMIT 1`,
      )
      .get();
    if (invalid) throw new Error("invalid migrated policy");
  }
  if (
    database
      .prepare(
        `SELECT 1 FROM scheduled_runs WHERE
    json_type(payload_json, '$.snapshot') IS NOT 'object' OR
    json_type(payload_json, '$.dispatch') NOT IN ('null', 'object') LIMIT 1`,
      )
      .get()
  )
    throw new Error("invalid migrated run");
}

function assertMigrationInput(database: Database.Database): void {
  for (const table of ["scheduled_tasks", "scheduled_runs"]) {
    if (
      database
        .prepare(
          `SELECT 1 FROM ${table} WHERE CASE
      WHEN json_valid(payload_json) THEN json_type(payload_json) != 'object'
      ELSE 1 END LIMIT 1`,
        )
        .get()
    )
      throw new Error("invalid source payload");
  }
  if (
    database
      .prepare(
        `SELECT 1 FROM scheduled_runs WHERE
    json_type(payload_json, '$.snapshot') IS NOT 'object' LIMIT 1`,
      )
      .get()
  )
    throw new Error("invalid source snapshot");
}
