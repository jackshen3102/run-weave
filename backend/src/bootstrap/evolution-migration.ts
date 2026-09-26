import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { logger } from "../logging/index";
import { acquireBackendProfileLock } from "../server/profile-lock";
import {
  resolveActivityStoragePaths,
  resolveEvolutionStoragePaths,
} from "../utils/path";
import { auditRepositoryMigration } from "../evolution/storage/repository-migration-audit";
import {
  openReadOnly,
  type MigrationManifest,
} from "../evolution/storage/repository-migration-integrity";
import { applyRepositoryMigration } from "../evolution/storage/repository-migration-apply";
import {
  assertOffline,
  privateJson,
} from "../evolution/storage/repository-migration-files";
import { resumeMigratedSchedules } from "../evolution/storage/repository-migration-schedules";

/** Runs before either SQLite worker or any business producer is started. */
export async function prepareEvolutionRepositoryMigration() {
  const { evolutionHomeDir, learningDatabaseFile } =
    resolveEvolutionStoragePaths();
  const { activityDatabaseFile } = resolveActivityStoragePaths();
  // Use a data-directory lock, not the Backend profile lock: multiple profiles
  // share these databases. Publication and dead-owner recovery are atomic.
  const lock = await acquireBackendProfileLock({
    profileDir: path.join(evolutionHomeDir, "repository-startup"),
    port: null,
    host: undefined,
  });
  try {
    if (!existsSync(learningDatabaseFile)) return { status: "fresh" } as const;
    const database = openReadOnly(learningDatabaseFile);
    let metadata: Record<string, string>;
    try {
      const hasMetadata = database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='evolution_metadata'",
        )
        .get();
      if (
        !hasMetadata &&
        database
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
          )
          .get()
      )
        throw new Error("evolution_repository_migration_metadata_missing");
      metadata = hasMetadata
        ? Object.fromEntries(
            (
              database
                .prepare("SELECT key,value FROM evolution_metadata")
                .all() as Array<{ key: string; value: string }>
            ).map((row) => [row.key, row.value]),
          )
        : {};
    } finally {
      database.close();
    }
    if (
      Number(metadata.minimumWriterVersion ?? 1) > 2 ||
      Number(metadata.schemaVersion ?? 0) > 6
    )
      throw new Error("evolution_repository_migration_newer_database");
    const manifestFile = path.join(
      evolutionHomeDir,
      "repository-startup",
      "manifest.json",
    );
    let manifest: MigrationManifest | undefined = existsSync(manifestFile)
      ? (JSON.parse(readFileSync(manifestFile, "utf8")) as MigrationManifest)
      : undefined;
    if (
      metadata.schemaVersion === "6" &&
      metadata.repositoryMigrationState === "complete" &&
      (!manifest ||
        metadata.repositorySchedulesResumed === manifest.migrationId)
    )
      return { status: "current" } as const;
    if (!manifest && !metadata.schemaVersion)
      return { status: "fresh" } as const;
    const dataDir = path.dirname(evolutionHomeDir);
    if (
      learningDatabaseFile !==
        path.join(dataDir, "evolution/learning.sqlite") ||
      activityDatabaseFile !== path.join(dataDir, "activity/activity.sqlite")
    )
      throw new Error(
        "evolution_repository_migration_requires_paired_data_directory",
      );
    if (!existsSync(activityDatabaseFile))
      throw new Error(
        "evolution_repository_migration_activity_database_missing",
      );
    assertOffline([activityDatabaseFile, learningDatabaseFile]);
    logger.info("evolution.repository-migration.started", {
      dataDir,
      migrationId: manifest?.migrationId,
    });
    if (!manifest) {
      manifest = await auditRepositoryMigration(dataDir);
      // Persist before apply so even interruption between the two DB commits
      // resumes this exact audited operation instead of deriving a new one.
      privateJson(manifestFile, manifest);
    }
    await applyRepositoryMigration(manifest, dataDir);
    const schedules = await resumeMigratedSchedules(manifest, dataDir);
    logger.info("evolution.repository-migration.completed", {
      migrationId: manifest.migrationId,
      repositories: manifest.repositories.length,
      schedules,
    });
    return {
      status: "migrated",
      migrationId: manifest.migrationId,
      schedules,
    } as const;
  } catch (error) {
    logger.error("evolution.repository-migration.blocked", {
      message:
        "Backend startup stopped before opening Activity/Evolution; stop other database owners and restart after resolving the migration error. Backups and migration journal are retained.",
      error,
    });
    throw error;
  } finally {
    await lock.release();
  }
}
