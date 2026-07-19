import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { DevSessionError } from "./contracts.mjs";
import {
  resolveBetaPoolStoragePaths,
  resolveCanonicalBetaPoolPaths,
  resolveLegacyBetaPoolPaths,
} from "./beta-slot-pool-storage-paths.mjs";
import {
  STORAGE_KIND,
  STORAGE_SCHEMA_VERSION,
  acquireMigrationLock,
  atomicWriteJson,
  copyLegacyData,
  directoryEntries,
  ensureSafeDirectory,
  findPendingMigrations,
  fingerprintTree,
  inspectBetaPoolStorage,
  inspectLegacyActivity,
  lstat,
  migrationError,
  readJson,
  releaseMigrationLock,
} from "./beta-slot-pool-storage-support.mjs";

export { inspectBetaPoolStorage };

function injectMigrationFailure(checkpoint) {
  if (
    process.env.RUNWEAVE_BETA_POOL_MIGRATION_FAILPOINT?.trim() === checkpoint
  ) {
    throw new Error(`injected Beta pool migration failure at ${checkpoint}`);
  }
}

async function resumePendingMigration(homeDir, observed) {
  const storage = resolveBetaPoolStoragePaths(homeDir);
  await ensureSafeDirectory(storage.controlRoot);
  await ensureSafeDirectory(storage.migrationRoot);
  const lock = await acquireMigrationLock(storage.migrationLockPath);
  if (!lock) {
    throw migrationError(
      "Beta pool storage migration is busy",
      "beta_pool_storage_migration_busy",
      observed,
      ["migration-lock-busy"],
      { suggestedAction: "Wait for the current migration and retry." },
    );
  }
  try {
    const pending = await findPendingMigrations(storage);
    const journal = pending.find(
      (entry) => entry.migrationId === observed.migrationId,
    );
    if (!journal) {
      throw new Error("pending migration journal is missing");
    }
    const journalPath = path.join(
      storage.migrationRoot,
      journal.migrationId,
      "journal.json",
    );
    if (["preparing", "staged"].includes(journal.state)) {
      if (await lstat(storage.canonicalPoolRoot)) {
        throw new Error("canonical root exists before migration publish");
      }
      await fs.rm(journal.stagingPath, { recursive: true, force: true });
      await atomicWriteJson(journalPath, {
        ...journal,
        state: "rolled_back",
        rolledBackAt: new Date().toISOString(),
      });
      return null;
    }

    const marker = await readJson(
      path.join(storage.canonicalPoolRoot, "storage.json"),
    );
    if (
      marker?.storage !== STORAGE_KIND ||
      marker.migrationId !== journal.migrationId ||
      marker.sourceFingerprint !== journal.sourceFingerprint
    ) {
      throw new Error("canonical marker does not match migration journal");
    }
    const backupStats = await lstat(journal.backupPath);
    const legacyStats = await lstat(storage.legacyPoolRoot);
    if (legacyStats?.isDirectory()) {
      if (backupStats) {
        throw new Error("legacy root and migration backup both exist");
      }
      if (
        (await fingerprintTree(storage.legacyPoolRoot)) !==
        journal.sourceFingerprint
      ) {
        throw new Error("legacy source fingerprint changed after publish");
      }
      await fs.rename(storage.legacyPoolRoot, journal.backupPath);
      await atomicWriteJson(journalPath, {
        ...journal,
        state: "legacy_archived",
      });
    } else if (!backupStats?.isDirectory()) {
      throw new Error("legacy migration backup is missing");
    }
    const completedAt = new Date().toISOString();
    await atomicWriteJson(storage.legacyPoolRoot, {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      state: "migrated",
      canonicalRoot: storage.canonicalPoolRoot,
      migrationId: journal.migrationId,
      backupPath: journal.backupPath,
      completedAt,
    });
    await atomicWriteJson(
      path.join(storage.canonicalPoolRoot, "storage.json"),
      { ...marker, completedAt },
    );
    await atomicWriteJson(journalPath, {
      ...journal,
      state: "completed",
      completedAt,
    });
    return resolveCanonicalBetaPoolPaths(homeDir);
  } catch (error) {
    throw migrationError(
      "Beta pool storage migration could not resume; state was preserved",
      "beta_pool_storage_migration_blocked",
      observed,
      [error instanceof Error ? error.message : String(error)],
      { suggestedAction: "Inspect pnpm dev:pool --json before retrying." },
    );
  } finally {
    await releaseMigrationLock(storage.migrationLockPath, lock);
  }
}

async function createCanonicalStorage(homeDir) {
  const paths = resolveCanonicalBetaPoolPaths(homeDir);
  await ensureSafeDirectory(paths.storage.controlRoot);
  await ensureSafeDirectory(paths.poolRoot);
  await atomicWriteJson(path.join(paths.poolRoot, "storage.json"), {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    storage: STORAGE_KIND,
    migrationId: null,
    migratedFrom: null,
    backupPath: null,
    sourceFingerprint: null,
    completedAt: new Date().toISOString(),
  });
  return paths;
}

async function migrateLegacyPool(homeDir, observed) {
  const storage = resolveBetaPoolStoragePaths(homeDir);
  await ensureSafeDirectory(storage.controlRoot);
  await ensureSafeDirectory(storage.migrationRoot);
  const legacyParent = await lstat(storage.legacyBetaRoot);
  if (!legacyParent?.isDirectory() || legacyParent.isSymbolicLink()) {
    throw migrationError(
      "Legacy Beta pool parent is unsafe",
      "beta_pool_storage_migration_blocked",
      observed,
      ["legacy-beta-root-unsafe"],
    );
  }
  const lock = await acquireMigrationLock(storage.migrationLockPath);
  if (!lock) {
    throw migrationError(
      "Beta pool storage migration is busy",
      "beta_pool_storage_migration_busy",
      observed,
      ["migration-lock-busy"],
      { suggestedAction: "Wait for the current migration and retry." },
    );
  }
  try {
    const current = await inspectBetaPoolStorage({ homeDir });
    if (current.mode === "canonical") {
      return resolveCanonicalBetaPoolPaths(homeDir);
    }
    if (current.mode !== "legacy-draining") {
      throw migrationError(
        "Beta pool storage state blocks migration",
        "beta_pool_storage_conflict",
        current,
        current.blockedBy,
        { suggestedAction: "Inspect pnpm dev:pool --json before retrying." },
      );
    }
    if (current.blockedBy.length > 0) {
      throw migrationError(
        "Legacy Beta pool must be drained before migration",
        "beta_pool_legacy_drain_required",
        current,
        current.blockedBy,
        {
          legacyOwners: current.legacyOwners,
          suggestedAction:
            "Stop the listed owner sessions, then retry the Beta start.",
        },
      );
    }

    const migrationId = randomUUID();
    const operationRoot = path.join(storage.migrationRoot, migrationId);
    const journalPath = path.join(operationRoot, "journal.json");
    const stagingPath = path.join(
      storage.controlRoot,
      `.beta-pool.${migrationId}.staging`,
    );
    const backupPath = path.join(
      storage.legacyBetaRoot,
      `pool.migrated-${migrationId}`,
    );
    await fs.mkdir(operationRoot, { recursive: true, mode: 0o700 });
    const sourceFingerprint = await fingerprintTree(storage.legacyPoolRoot);
    const journal = {
      schemaVersion: 1,
      migrationId,
      state: "preparing",
      legacyRoot: storage.legacyPoolRoot,
      canonicalRoot: storage.canonicalPoolRoot,
      stagingPath,
      backupPath,
      sourceFingerprint,
      startedAt: new Date().toISOString(),
    };
    await atomicWriteJson(journalPath, journal);
    await copyLegacyData(storage.legacyPoolRoot, stagingPath);
    const copiedFingerprint = await fingerprintTree(stagingPath);
    await atomicWriteJson(path.join(stagingPath, "storage.json"), {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      storage: STORAGE_KIND,
      migrationId,
      migratedFrom: storage.legacyPoolRoot,
      backupPath,
      sourceFingerprint,
      completedAt: null,
    });
    await atomicWriteJson(journalPath, {
      ...journal,
      state: "staged",
      copiedFingerprint,
    });
    injectMigrationFailure("after_staged");
    const activityBeforePublish = await inspectLegacyActivity(
      resolveLegacyBetaPoolPaths(homeDir),
    );
    if (activityBeforePublish.blockers.length > 0) {
      throw new Error(
        `legacy Beta pool became active during migration: ${activityBeforePublish.blockers.join(", ")}`,
      );
    }
    if ((await fingerprintTree(storage.legacyPoolRoot)) !== sourceFingerprint) {
      throw new Error("legacy Beta pool changed during migration");
    }
    await fs.rename(stagingPath, storage.canonicalPoolRoot);
    await atomicWriteJson(journalPath, {
      ...journal,
      state: "canonical_published",
      copiedFingerprint,
    });
    injectMigrationFailure("after_canonical_published");
    const activityBeforeArchive = await inspectLegacyActivity(
      resolveLegacyBetaPoolPaths(homeDir),
    );
    if (activityBeforeArchive.blockers.length > 0) {
      throw new Error(
        `legacy Beta pool became active before archive: ${activityBeforeArchive.blockers.join(", ")}`,
      );
    }
    if ((await fingerprintTree(storage.legacyPoolRoot)) !== sourceFingerprint) {
      throw new Error("legacy Beta pool changed before archive");
    }
    await fs.rename(storage.legacyPoolRoot, backupPath);
    await atomicWriteJson(journalPath, {
      ...journal,
      state: "legacy_archived",
      copiedFingerprint,
    });
    injectMigrationFailure("after_legacy_archived");
    const completedAt = new Date().toISOString();
    await atomicWriteJson(storage.legacyPoolRoot, {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      state: "migrated",
      canonicalRoot: storage.canonicalPoolRoot,
      migrationId,
      backupPath,
      completedAt,
    });
    await atomicWriteJson(
      path.join(storage.canonicalPoolRoot, "storage.json"),
      {
        schemaVersion: STORAGE_SCHEMA_VERSION,
        storage: STORAGE_KIND,
        migrationId,
        migratedFrom: storage.legacyPoolRoot,
        backupPath,
        sourceFingerprint,
        completedAt,
      },
    );
    await atomicWriteJson(journalPath, {
      ...journal,
      state: "completed",
      copiedFingerprint,
      completedAt,
    });
    return resolveCanonicalBetaPoolPaths(homeDir);
  } catch (error) {
    if (error instanceof DevSessionError) {
      throw error;
    }
    throw migrationError(
      "Beta pool storage migration failed; state was preserved",
      "beta_pool_storage_migration_blocked",
      observed,
      [error instanceof Error ? error.message : String(error)],
      { suggestedAction: "Inspect pnpm dev:pool --json before retrying." },
    );
  } finally {
    await releaseMigrationLock(storage.migrationLockPath, lock);
  }
}

export async function prepareBetaPoolStorageForAllocation({ homeDir } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = await inspectBetaPoolStorage({ homeDir });
    if (observed.mode === "canonical") {
      if (observed.markerMissing) {
        return await createCanonicalStorage(homeDir);
      }
      return resolveCanonicalBetaPoolPaths(homeDir);
    }
    if (observed.mode === "uninitialized") {
      return await createCanonicalStorage(homeDir);
    }
    if (observed.mode === "legacy-draining") {
      return await migrateLegacyPool(homeDir, observed);
    }
    if (observed.mode === "migration-resumable") {
      const resumed = await resumePendingMigration(homeDir, observed);
      if (resumed) {
        return resumed;
      }
      continue;
    }
    throw migrationError(
      "Beta pool storage roots conflict",
      "beta_pool_storage_conflict",
      observed,
      observed.blockedBy,
      { suggestedAction: "Inspect pnpm dev:pool --json before retrying." },
    );
  }
  const observed = await inspectBetaPoolStorage({ homeDir });
  throw migrationError(
    "Beta pool storage migration did not converge",
    "beta_pool_storage_migration_blocked",
    observed,
    observed.blockedBy,
    { suggestedAction: "Inspect pnpm dev:pool --json before retrying." },
  );
}

export async function assertBetaPoolStorageReadyForExistingLease({
  homeDir,
} = {}) {
  const observed = await inspectBetaPoolStorage({ homeDir });
  if (
    observed.mode === "canonical" ||
    observed.mode === "legacy-draining" ||
    observed.mode === "uninitialized"
  ) {
    return observed;
  }
  throw migrationError(
    "Beta pool storage migration must converge before lease mutation",
    observed.mode === "conflict"
      ? "beta_pool_storage_conflict"
      : "beta_pool_storage_migration_blocked",
    observed,
    observed.blockedBy,
    { suggestedAction: "Retry the original Beta start to resume migration." },
  );
}

export async function rollbackBetaPoolStorageMigration({ homeDir } = {}) {
  const observed = await inspectBetaPoolStorage({ homeDir });
  if (observed.mode !== "canonical" || !observed.migration?.migrationId) {
    throw migrationError(
      "Beta pool storage is not a completed migration",
      "beta_pool_storage_migration_blocked",
      observed,
      ["completed-migration-not-found"],
    );
  }
  const storage = resolveBetaPoolStoragePaths(homeDir);
  const canonical = resolveCanonicalBetaPoolPaths(homeDir);
  await ensureSafeDirectory(storage.controlRoot);
  await ensureSafeDirectory(storage.migrationRoot);
  const lock = await acquireMigrationLock(storage.migrationLockPath);
  if (!lock) {
    throw migrationError(
      "Beta pool storage migration is busy",
      "beta_pool_storage_migration_busy",
      observed,
      ["migration-lock-busy"],
    );
  }
  try {
    const [leases, claims] = await Promise.all([
      directoryEntries(canonical.leasesDir),
      directoryEntries(canonical.recoveryClaimsDir),
    ]);
    if (!Array.isArray(leases) || !Array.isArray(claims)) {
      throw new Error("canonical lease or recovery claim path is unsafe");
    }
    if (leases.length > 0 || claims.length > 0) {
      throw new Error("canonical leases or recovery claims remain");
    }
    const [marker, tombstone] = await Promise.all([
      readJson(path.join(canonical.poolRoot, "storage.json")),
      readJson(storage.legacyPoolRoot),
    ]);
    const migrationId = observed.migration.migrationId;
    if (
      marker?.migrationId !== migrationId ||
      tombstone?.migrationId !== migrationId ||
      tombstone.backupPath !== observed.migration.backupPath
    ) {
      throw new Error("migration marker, tombstone, and backup do not match");
    }
    const backupStats = await lstat(tombstone.backupPath);
    if (!backupStats?.isDirectory() || backupStats.isSymbolicLink()) {
      throw new Error("legacy migration backup is missing or unsafe");
    }
    const journalPath = path.join(
      storage.migrationRoot,
      migrationId,
      "journal.json",
    );
    const rollbackArchive = path.join(
      storage.migrationRoot,
      migrationId,
      "canonical-rollback",
    );
    if (await lstat(rollbackArchive)) {
      throw new Error("canonical rollback archive already exists");
    }
    await fs.rename(storage.canonicalPoolRoot, rollbackArchive);
    await fs.rm(storage.legacyPoolRoot);
    await fs.rename(tombstone.backupPath, storage.legacyPoolRoot);
    const journal = (await readJson(journalPath)) ?? {};
    await atomicWriteJson(journalPath, {
      ...journal,
      schemaVersion: 1,
      migrationId,
      state: "rolled_back",
      rollbackArchive,
      rolledBackAt: new Date().toISOString(),
    });
    return {
      schemaVersion: 1,
      migrationId,
      state: "rolled_back",
      legacyRoot: storage.legacyPoolRoot,
      rollbackArchive,
    };
  } catch (error) {
    throw migrationError(
      "Beta pool storage rollback was refused; state was preserved",
      "beta_pool_storage_migration_blocked",
      observed,
      [error instanceof Error ? error.message : String(error)],
    );
  } finally {
    await releaseMigrationLock(storage.migrationLockPath, lock);
  }
}
