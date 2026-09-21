import type Database from "better-sqlite3";
import type {
  EvolutionRepository,
  EvolutionRepositoryAttribution,
  EvolutionReflectionBatch,
} from "@runweave/shared/evolution";
import type { RepositoryCommand, RepositoryResult } from "../repository-store";
import type { EvolutionRun } from "@runweave/shared/evolution";

export function initializeEvolutionRepositories(
  database: Database.Database,
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS evolution_repositories(repository_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evolution_repository_bindings(
      kind TEXT NOT NULL, id TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS evolution_topic_lineage(
      canonical_insight_id TEXT NOT NULL, legacy_insight_id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evolution_reflection_batches(
      batch_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evolution_repository_migrations(
      migration_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
  `);
  const columns = database
    .prepare("PRAGMA table_info(evolution_runs)")
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "repository_json"))
    database.exec("ALTER TABLE evolution_runs ADD COLUMN repository_json TEXT");
}

export function readRepositoryAttribution(
  database: Database.Database,
  kind: string,
  id: string,
): EvolutionRepositoryAttribution | undefined {
  const row = database
    .prepare(
      "SELECT payload_json FROM evolution_repository_bindings WHERE kind = ? AND id = ?",
    )
    .get(kind, id) as { payload_json: string } | undefined;
  return row
    ? (JSON.parse(row.payload_json) as EvolutionRepositoryAttribution)
    : undefined;
}

export function executeRepositoryCommand(
  database: Database.Database,
  foundation: { createRun(run: EvolutionRun): void },
  command: RepositoryCommand,
): RepositoryResult {
  switch (command.op) {
    case "list":
      return (
        database
          .prepare(
            "SELECT payload_json FROM evolution_repositories ORDER BY repository_id",
          )
          .all() as Array<{ payload_json: string }>
      ).map((row) => JSON.parse(row.payload_json) as EvolutionRepository);
    case "put": {
      return database
        .transaction(() => {
          const row = database
            .prepare(
              "SELECT payload_json FROM evolution_repositories WHERE repository_id = ?",
            )
            .get(command.repository.repositoryId) as
            | { payload_json: string }
            | undefined;
          const previous = row
            ? (JSON.parse(row.payload_json) as EvolutionRepository)
            : null;
          if (
            previous &&
            previous.commonDirectory !== command.repository.commonDirectory
          )
            throw new Error("evolution_repository_identity_conflict");
          const repository = {
            ...command.repository,
            paths: [
              ...new Set([
                ...(previous?.paths ?? []),
                ...command.repository.paths,
              ]),
            ],
            projectIds: [
              ...new Set([
                ...(previous?.projectIds ?? []),
                ...command.repository.projectIds,
              ]),
            ],
          };
          database
            .prepare(
              "INSERT INTO evolution_repositories VALUES (?,?) ON CONFLICT(repository_id) DO UPDATE SET payload_json=excluded.payload_json",
            )
            .run(repository.repositoryId, JSON.stringify(repository));
          return true;
        })
        .immediate();
    }
    case "attribution":
      return (
        readRepositoryAttribution(database, command.kind, command.id) ?? null
      );
    case "batch-get": {
      const row = database
        .prepare(
          "SELECT payload_json FROM evolution_reflection_batches WHERE idempotency_key = ?",
        )
        .get(command.key) as { payload_json: string } | undefined;
      return row
        ? (JSON.parse(row.payload_json) as EvolutionReflectionBatch)
        : null;
    }
    case "batch-create":
      return database
        .transaction(() => {
          const previous = executeRepositoryCommand(database, foundation, {
            op: "batch-get",
            key: command.batch.idempotencyKey,
          });
          if (previous) return previous;
          for (const run of command.runs) foundation.createRun(run);
          database
            .prepare("INSERT INTO evolution_reflection_batches VALUES (?,?,?)")
            .run(
              command.batch.batchId,
              command.batch.idempotencyKey,
              JSON.stringify(command.batch),
            );
          return command.batch;
        })
        .immediate();
  }
}
