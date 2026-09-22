import {
  privateJson,
  assertOffline,
  acquireMigrationLock,
  backupDatabase,
  currentFingerprints,
  databaseClone,
} from "./repository-migration-files";
import type Database from "better-sqlite3";
import { openEvolutionDatabase } from "./sqlite-driver";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import type {
  CandidateAsset,
  EvolutionSchedule,
} from "@runweave/shared/evolution";
import { defaultEvolutionScopePolicy } from "../knowledge/lifecycle";
import {
  bindActivityRepositories,
  initializeRepositoryIndex,
} from "../../activity/database/repository-index";
import { initializeEvolutionRepositories } from "./repository-database";
import {
  fingerprint,
  hash,
  manifestDigest,
  openReadOnly,
  tableDigest,
  tables,
  type MigrationManifest,
} from "./repository-migration-integrity";

interface Journal {
  migrationId: string;
  manifestDigest: string;
  phase: "backed_up" | "activity" | "complete" | "rolled_back";
  before: { activity: string; evolution: string };
  after?: { activity: string; evolution: string };
  rollbackFrom?: { activity: string; evolution: string };
}
function locations(dataDir: string, id: string) {
  if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error("migration_id_invalid");
  return {
    activity: path.join(dataDir, "activity/activity.sqlite"),
    evolution: path.join(dataDir, "evolution/learning.sqlite"),
    directory: path.join(dataDir, "evolution/repository-migrations", id),
    lock: path.join(dataDir, "evolution/repository-migration.lock"),
  };
}
function assertManifest(manifest: MigrationManifest) {
  if (manifest.version !== 1 || manifest.digest !== manifestDigest(manifest))
    throw new Error("migration_manifest_digest_mismatch");
}
export async function applyRepositoryMigration(
  manifest: MigrationManifest,
  dataDir: string,
  checkpoints?: { afterActivityCommit?: () => void },
): Promise<Journal> {
  assertManifest(manifest);
  const files = locations(dataDir, manifest.migrationId);
  acquireMigrationLock(files.lock, manifest.migrationId);
  try {
    assertOffline([files.activity, files.evolution]);
    mkdirSync(files.directory, { recursive: true, mode: 0o700 });
    const journalFile = path.join(files.directory, "journal.json");
    let journal: Journal | undefined = existsSync(journalFile)
      ? (JSON.parse(readFileSync(journalFile, "utf8")) as Journal)
      : undefined;
    if (journal && journal.manifestDigest !== manifest.digest)
      throw new Error("migration_manifest_conflict");
    if (journal?.phase === "complete") return journal;
    if (journal?.rollbackFrom)
      throw new Error("migration_rollback_in_progress");
    if (journal?.phase === "rolled_back")
      throw new Error("migration_already_rolled_back");
    if (!journal) {
      const current = currentFingerprints(files);
      if (JSON.stringify(current) !== JSON.stringify(manifest.fingerprints))
        throw new Error("migration_input_changed");
      for (const kind of ["activity", "evolution"] as const) {
        await backupDatabase(
          files[kind],
          path.join(files.directory, `${kind}.sqlite`),
        );
      }
      if (
        JSON.stringify(currentFingerprints(files)) !== JSON.stringify(current)
      )
        throw new Error("migration_input_changed_during_backup");
      privateJson(path.join(files.directory, "manifest.json"), manifest);
      journal = {
        migrationId: manifest.migrationId,
        manifestDigest: manifest.digest,
        phase: "backed_up",
        before: current,
      };
      privateJson(journalFile, journal);
    }
    const evolution = openEvolutionDatabase(files.evolution),
      activity = openEvolutionDatabase(files.activity);
    try {
      evolution.pragma("foreign_keys = ON");
      activity.pragma("foreign_keys = ON");
      assertOriginalActivity(activity, manifest);
      assertExpectedEvolution(evolution, manifest, files.directory);
      const mark = evolution.prepare(
        "INSERT INTO evolution_metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      );
      evolution
        .transaction(() => {
          mark.run("minimumWriterVersion", "2");
          mark.run("repositoryMigrationState", "in_progress");
        })
        .immediate();
      if (journal.phase === "backed_up") {
        activity
          .transaction(() => {
            initializeRepositoryIndex(activity);
            bindActivityRepositories(activity, manifest.activityBindings);
          })
          .immediate();
        journal.phase = "activity";
        privateJson(journalFile, journal);
      }
      checkpoints?.afterActivityCommit?.();
      evolution
        .transaction(() => {
          initializeEvolutionRepositories(evolution);
          const applied = evolution
            .prepare(
              "SELECT 1 FROM evolution_repository_migrations WHERE migration_id=?",
            )
            .get(manifest.migrationId);
          if (!applied) transformEvolution(evolution, manifest);
          mark.run("schemaVersion", "6");
          evolution
            .prepare(
              "INSERT OR IGNORE INTO evolution_repository_migrations VALUES (?,?)",
            )
            .run(
              manifest.migrationId,
              JSON.stringify({
                digest: manifest.digest,
                at: manifest.createdAt,
              }),
            );
        })
        .immediate();
      verifyOpenDatabases(activity, evolution, manifest, files.directory);
      mark.run("repositoryMigrationState", "complete");
      journal.phase = "complete";
      journal.after = {
        activity: fingerprint(activity),
        evolution: fingerprint(evolution),
      };
      privateJson(journalFile, journal);
      return journal;
    } finally {
      activity.close();
      evolution.close();
    }
  } finally {
    rmSync(files.lock, { recursive: true });
  }
}

function transformEvolution(
  database: Database.Database,
  manifest: MigrationManifest,
): void {
  // Owners are offline. Keep unfinished legacy runs as history; they cannot
  // resume with Project-scoped input under the repository-scoped runner.
  const stopped = database
    .prepare(
      "UPDATE evolution_runs SET stage='blocked',outcome='blocked',updated_at_ms=?,completed_at_ms=?,owner_id=NULL,fencing_token=NULL WHERE stage IN ('queued','snapshotting','segmenting','independent_analysis','cross_questioning','adjudicating','novelty_check','validating')",
    )
    .run(Date.parse(manifest.createdAt), Date.parse(manifest.createdAt));
  if (stopped.changes)
    database.prepare("UPDATE evolution_leases SET expires_at_ms=0").run();
  for (const repository of manifest.repositories) {
    database
      .prepare("INSERT OR IGNORE INTO evolution_repositories VALUES (?,?)")
      .run(repository.repositoryId, JSON.stringify(repository));
    const policy = {
      ...defaultEvolutionScopePolicy(
        repository.repositoryId,
        manifest.createdAt,
      ),
      revision: 1,
      updatedBy: `migration:${manifest.migrationId}`,
    };
    database
      .prepare("INSERT OR IGNORE INTO evolution_policies VALUES (?,?,?)")
      .run(repository.repositoryId, policy.revision, JSON.stringify(policy));
  }
  for (const entry of manifest.attributions)
    database
      .prepare("INSERT INTO evolution_repository_bindings VALUES (?,?,?)")
      .run(entry.kind, entry.id, JSON.stringify(entry.value));
  for (const move of manifest.insightMoves) {
    database
      .prepare("INSERT INTO evolution_topic_lineage VALUES (?,?,?)")
      .run(move.canonicalId, move.id, move.conflict ? "contested" : "resolved");
    if (move.id === move.canonicalId)
      database
        .prepare("UPDATE insights SET learning_scope_id=? WHERE insight_id=?")
        .run(move.repositoryId, move.id);
  }
  for (const move of manifest.candidateMoves) {
    const row = database
      .prepare(
        "SELECT payload_json FROM candidate_asset_revisions WHERE revision_id=?",
      )
      .get(move.revisionId) as { payload_json: string };
    const previous = JSON.parse(row.payload_json) as CandidateAsset;
    const lifecycle =
      previous.lifecycle === "retired"
        ? "retired"
        : move.conflict
          ? "needs_revalidation"
          : previous.lifecycle === "canary" || previous.lifecycle === "promoted"
            ? "shadow"
            : previous.lifecycle;
    const migratedAt = new Date(
      Math.max(
        Date.parse(manifest.createdAt),
        Date.parse(previous.updatedAt) + 1,
      ),
    ).toISOString();
    const candidate: CandidateAsset = {
      ...previous,
      learningScopeId: move.repositoryId,
      repositoryId: move.repositoryId,
      revisionId: `arev:${hash(`${manifest.migrationId}:${previous.revisionId}`).slice(0, 32)}`,
      lifecycle,
      updatedAt: migratedAt,
      lifecycleHistory: [
        ...previous.lifecycleHistory,
        {
          eventId: `migration:${manifest.migrationId}:${previous.assetId}`,
          from: previous.lifecycle,
          to: lifecycle,
          actor: "repository-migration",
          reason: `repository_scope_changed_from:${previous.learningScopeId};previous_revision:${previous.revisionId}`,
          evidenceRefs: previous.evidenceRefs,
          at: migratedAt,
        },
      ],
    };
    database
      .prepare("INSERT INTO candidate_asset_revisions VALUES (?,?,?,?,?)")
      .run(
        candidate.revisionId,
        candidate.assetId,
        candidate.learningScopeId,
        candidate.updatedAt,
        JSON.stringify(candidate),
      );
  }
  for (const move of manifest.schedules) {
    const row = database
      .prepare(
        "SELECT payload_json FROM evolution_schedules WHERE schedule_id=?",
      )
      .get(move.id) as { payload_json: string };
    const previous = JSON.parse(row.payload_json) as EvolutionSchedule;
    const schedule: EvolutionSchedule = {
      ...previous,
      enabled: false,
      nextDueAt: null,
      updatedAt: manifest.createdAt,
      ...(move.repositoryId && move.cwd
        ? {
            learningScopeId: move.repositoryId,
            repositoryId: move.repositoryId,
            repository: { repositoryId: move.repositoryId, cwd: move.cwd },
            pausedReason: "migration_verification_required",
          }
        : { pausedReason: "repository_attribution_unresolved" }),
    };
    database
      .prepare(
        "UPDATE evolution_schedules SET learning_scope_id=?,enabled=0,updated_at_ms=?,payload_json=? WHERE schedule_id=?",
      )
      .run(
        schedule.learningScopeId,
        Date.parse(manifest.createdAt),
        JSON.stringify(schedule),
        move.id,
      );
  }
  // No new repository watermark: the initial run starts at zero, with migrated knowledge as its baseline.
}

function verifyOpenDatabases(
  activity: Database.Database,
  evolution: Database.Database,
  manifest: MigrationManifest,
  backupDir: string,
): void {
  for (const database of [activity, evolution]) {
    if (
      database.pragma("quick_check", { simple: true }) !== "ok" ||
      (database.pragma("foreign_key_check") as unknown[]).length
    )
      throw new Error("migration_integrity_failed");
  }
  for (const [table, digest] of Object.entries(manifest.immutable))
    if (tableDigest(evolution, table) !== digest)
      throw new Error(`migration_immutable_changed:${table}`);
  assertOriginalActivity(activity, manifest);
  assertExpectedEvolution(evolution, manifest, backupDir);
  for (const binding of manifest.activityBindings) {
    const current = activity
      .prepare(
        "SELECT repository_id FROM activity_repository_bindings WHERE event_id=?",
      )
      .get(binding.eventId) as { repository_id: string | null } | undefined;
    if (current?.repository_id !== binding.repositoryId)
      throw new Error("migration_binding_mismatch");
  }
  const originalActivity = openReadOnly(
    path.join(backupDir, "activity.sqlite"),
  );
  const originalEvolution = openReadOnly(
    path.join(backupDir, "evolution.sqlite"),
  );
  try {
    if (
      tableDigest(activity, "behavior_facts") !==
      tableDigest(originalActivity, "behavior_facts")
    )
      throw new Error("migration_activity_changed");
    for (const row of originalEvolution
      .prepare("SELECT revision_id,payload_json FROM candidate_asset_revisions")
      .iterate() as Iterable<{ revision_id: string; payload_json: string }>) {
      const current = evolution
        .prepare(
          "SELECT payload_json FROM candidate_asset_revisions WHERE revision_id=?",
        )
        .get(row.revision_id) as { payload_json: string } | undefined;
      if (current?.payload_json !== row.payload_json)
        throw new Error("migration_candidate_history_changed");
    }
    for (const table of ["evolution_runs", "insights", "evolution_schedules"]) {
      const key =
        table === "evolution_runs"
          ? "run_id"
          : table === "insights"
            ? "insight_id"
            : "schedule_id";
      for (const row of originalEvolution
        .prepare(`SELECT ${key} AS id FROM ${table}`)
        .iterate() as Iterable<{ id: string }>)
        if (
          !evolution
            .prepare(`SELECT 1 FROM ${table} WHERE ${key}=?`)
            .get(row.id)
        )
          throw new Error(`migration_missing_original:${table}`);
    }
  } finally {
    originalActivity.close();
    originalEvolution.close();
  }
}

export function verifyRepositoryMigration(
  manifest: MigrationManifest,
  dataDir: string,
): { ok: true; migrationId: string } {
  assertManifest(manifest);
  const files = locations(dataDir, manifest.migrationId);
  const activity = openReadOnly(files.activity),
    evolution = openReadOnly(files.evolution);
  try {
    const metadata = Object.fromEntries(
      (
        evolution
          .prepare("SELECT key,value FROM evolution_metadata")
          .all() as Array<{ key: string; value: string }>
      ).map((row) => [row.key, row.value]),
    );
    if (
      metadata.schemaVersion !== "6" ||
      metadata.minimumWriterVersion !== "2" ||
      metadata.repositoryMigrationState !== "complete"
    )
      throw new Error("migration_completion_metadata_invalid");
    verifyOpenDatabases(activity, evolution, manifest, files.directory);
    return { ok: true, migrationId: manifest.migrationId };
  } finally {
    activity.close();
    evolution.close();
  }
}

export async function rollbackRepositoryMigration(
  dataDir: string,
  id: string,
): Promise<Journal> {
  const files = locations(dataDir, id);
  assertOffline([files.activity, files.evolution]);
  acquireMigrationLock(files.lock, id);
  try {
    const journalFile = path.join(files.directory, "journal.json");
    const journal = JSON.parse(readFileSync(journalFile, "utf8")) as Journal;
    if (journal.phase === "rolled_back") return journal;
    const current = currentFingerprints(files);
    if (journal.rollbackFrom) {
      for (const kind of ["activity", "evolution"] as const)
        if (
          current[kind] !== journal.rollbackFrom[kind] &&
          current[kind] !== journal.before[kind]
        )
          throw new Error("migration_rollback_has_new_writes");
    } else {
      if (
        journal.phase === "complete" &&
        JSON.stringify(current) !== JSON.stringify(journal.after)
      )
        throw new Error("migration_rollback_has_new_writes");
      const manifest = JSON.parse(
        readFileSync(path.join(files.directory, "manifest.json"), "utf8"),
      ) as MigrationManifest;
      const activity = openReadOnly(files.activity),
        evolution = openReadOnly(files.evolution);
      try {
        assertOriginalActivity(activity, manifest);
        assertExpectedEvolution(evolution, manifest, files.directory);
      } finally {
        activity.close();
        evolution.close();
      }
      journal.rollbackFrom = current;
      privateJson(journalFile, journal);
    }
    for (const kind of ["activity", "evolution"] as const) {
      const backup = path.join(files.directory, `${kind}.sqlite`);
      const db = openReadOnly(backup);
      try {
        if (fingerprint(db) !== journal.before[kind])
          throw new Error("migration_backup_digest_mismatch");
      } finally {
        db.close();
      }
    }
    for (const kind of ["activity", "evolution"] as const) {
      if (currentFingerprints(files)[kind] === journal.before[kind]) continue;
      await backupDatabase(
        files[kind],
        path.join(files.directory, `${kind}.before-rollback.sqlite`),
      );
      copyFileSync(
        path.join(files.directory, `${kind}.sqlite`),
        `${files[kind]}.restore`,
      );
      chmodSync(`${files[kind]}.restore`, 0o600);
      renameSync(`${files[kind]}.restore`, files[kind]);
      rmSync(`${files[kind]}-wal`, { force: true });
      rmSync(`${files[kind]}-shm`, { force: true });
    }
    if (
      JSON.stringify(currentFingerprints(files)) !==
      JSON.stringify(journal.before)
    )
      throw new Error("migration_rollback_verification_failed");
    journal.phase = "rolled_back";
    privateJson(journalFile, journal);
    return journal;
  } finally {
    rmSync(files.lock, { recursive: true });
  }
}

export { privateJson } from "./repository-migration-files";

function assertOriginalActivity(
  database: Database.Database,
  manifest: MigrationManifest,
): void {
  for (const [table, digest] of Object.entries(manifest.activityDigests))
    if (tableDigest(database, table) !== digest)
      throw new Error(`migration_unexpected_writes:${table}`);
}
function assertExpectedEvolution(
  database: Database.Database,
  manifest: MigrationManifest,
  backupDir: string,
): void {
  const clone = databaseClone(path.join(backupDir, "evolution.sqlite"));
  const expected = clone.database;
  try {
    const transformed =
      tables(database).includes("evolution_repository_migrations") &&
      database
        .prepare(
          "SELECT 1 FROM evolution_repository_migrations WHERE migration_id=?",
        )
        .get(manifest.migrationId);
    if (transformed) {
      initializeEvolutionRepositories(expected);
      transformEvolution(expected, manifest);
    }
    for (const table of tables(expected)) {
      if (
        table === "evolution_metadata" ||
        table === "evolution_repository_migrations"
      )
        continue;
      if (tableDigest(database, table) !== tableDigest(expected, table))
        throw new Error(`migration_unexpected_writes:${table}`);
    }
  } finally {
    clone.dispose();
  }
}
