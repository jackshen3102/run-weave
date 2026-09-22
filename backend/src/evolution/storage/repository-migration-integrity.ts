import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type {
  EvolutionRepository,
  EvolutionRepositoryAttribution,
} from "@runweave/shared/evolution";
import type { ActivityRepositoryBinding } from "../../activity/database/repository-index";
import { openEvolutionDatabase } from "./sqlite-driver";

// Integrity contract shared by migration audit, apply, verification and recovery.
export interface MigrationManifest {
  version: 1;
  migrationId: string;
  createdAt: string;
  source: { activity: string; evolution: string };
  fingerprints: { activity: string; evolution: string };
  counts: {
    activity: Record<string, number>;
    evolution: Record<string, number>;
  };
  repositories: EvolutionRepository[];
  activityBindings: ActivityRepositoryBinding[];
  attributions: Array<{
    kind: string;
    id: string;
    value: EvolutionRepositoryAttribution;
  }>;
  insightMoves: Array<{
    id: string;
    repositoryId: string;
    canonicalId: string;
    conflict: boolean;
  }>;
  candidateMoves: Array<{
    revisionId: string;
    repositoryId: string;
    conflict: boolean;
  }>;
  schedules: Array<{
    id: string;
    repositoryId: string | null;
    cwd: string | null;
    wasEnabled: boolean;
  }>;
  immutable: Record<string, string>;
  activityDigests: Record<string, string>;
  digest: string;
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function manifestDigest(manifest: MigrationManifest): string {
  const content = { ...manifest, digest: undefined };
  return hash(JSON.stringify(content));
}
export function openReadOnly(file: string): Database.Database {
  const database = openEvolutionDatabase(file, {
    readonly: true,
    fileMustExist: true,
  });
  database.pragma("query_only = ON");
  return database;
}
export function tables(database: Database.Database): string[] {
  return (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}
export function tableDigest(
  database: Database.Database,
  table: string,
): string {
  if (!/^[a-z_]+$/u.test(table)) throw new Error("invalid_table");
  const digest = createHash("sha256");
  // Row order is kept by this additive migration; every original byte remains comparable.
  for (const row of database
    .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
    .iterate())
    digest.update(JSON.stringify(row) + "\n");
  return digest.digest("hex");
}
export function fingerprint(database: Database.Database): string {
  return hash(
    JSON.stringify(
      tables(database).map((table) => [table, tableDigest(database, table)]),
    ),
  );
}
export function counts(database: Database.Database): Record<string, number> {
  return Object.fromEntries(
    tables(database).map((table) => [
      table,
      (
        database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n,
    ]),
  );
}
export const IMMUTABLE_TABLES = [
  "context_packs",
  "context_pack_sources",
  "trace_segments",
  "episodes",
  "analysis_reports",
  "claims",
  "claim_novelty",
  "insight_revisions",
  "contribution_edges",
  "runtime_traces",
  "runtime_trace_events",
];
