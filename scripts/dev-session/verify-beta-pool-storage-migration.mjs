import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  acquireBetaSlotLease,
  inspectBetaPool,
  inspectBetaPoolStorage,
  prepareBetaPoolStorageForAllocation,
  releaseBetaSlotLease,
  resolveBetaPoolStoragePaths,
  resolveCanonicalBetaPoolPaths,
  resolveLegacyBetaPoolPaths,
  rollbackBetaPoolStorageMigration,
} from "./beta-slot-pool.mjs";

function leaseOptions(homeDir, ownerSessionId) {
  return {
    homeDir,
    ownerSessionId,
    ownerSourceRoot: process.cwd(),
    ownerRevision: "storage-migration-revision",
    ownerManifestPath: path.join(homeDir, `${ownerSessionId}.manifest.json`),
  };
}

async function createLegacyMetadata(homeDir) {
  const paths = resolveLegacyBetaPoolPaths(homeDir);
  await fs.mkdir(paths.metadataDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(paths.metadataDir, "pool-01.json"),
    `${JSON.stringify({ schemaVersion: 2, slotId: "pool-01" })}\n`,
    { mode: 0o600 },
  );
  const legacyOperation = path.join(
    paths.quarantineDir,
    "legacy-fixture-operation",
  );
  await fs.mkdir(legacyOperation, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(legacyOperation, "journal.json"), "{}\n", {
    mode: 0o600,
  });
  return paths;
}

async function verifyReadOnlyAndDrain(root) {
  const applicationsDir = path.join(root, "applications");
  const emptyHome = path.join(root, "empty");
  const storage = resolveBetaPoolStoragePaths(emptyHome);
  const projection = await inspectBetaPool({
    homeDir: emptyHome,
    applicationsDir,
  });
  assert.equal(projection.storage.mode, "uninitialized");
  assert.equal(await fs.lstat(storage.controlRoot).catch(() => null), null);
  assert.equal(await fs.lstat(storage.legacyBetaRoot).catch(() => null), null);

  const drainHome = path.join(root, "drain");
  const legacy = resolveLegacyBetaPoolPaths(drainHome);
  await fs.mkdir(legacy.leasesDir, { recursive: true, mode: 0o700 });
  const lease = {
    schemaVersion: 1,
    slotId: "pool-01",
    leaseNonce: "legacy-drain-nonce",
    ownerSessionId: "dvs-legacy-drain",
    ownerSourceRoot: process.cwd(),
    ownerRevision: "legacy-revision",
    ownerManifestPath: path.join(drainHome, "legacy.manifest.json"),
    allocatorPid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(legacy.leasesDir, "pool-01.lock"),
    `${JSON.stringify(lease)}\n`,
    { mode: 0o600 },
  );
  const legacyProjection = await inspectBetaPool({
    homeDir: drainHome,
    applicationsDir,
  });
  assert.equal(legacyProjection.storage.mode, "legacy-draining");
  await assert.rejects(
    acquireBetaSlotLease(leaseOptions(drainHome, "dvs-new-allocation")),
    (error) =>
      error?.details?.code === "beta_pool_legacy_drain_required" &&
      error.details.legacyOwners[0].ownerSessionId === "dvs-legacy-drain",
  );
  const canonical = resolveCanonicalBetaPoolPaths(drainHome);
  assert.equal(await fs.lstat(canonical.poolRoot).catch(() => null), null);
  await releaseBetaSlotLease({ ...lease, homeDir: drainHome });
}

async function verifyMigrationAndRollback(root) {
  const homeDir = path.join(root, "complete");
  const legacy = await createLegacyMetadata(homeDir);
  const lease = await acquireBetaSlotLease(
    leaseOptions(homeDir, "dvs-migrated-owner"),
  );
  const canonical = resolveCanonicalBetaPoolPaths(homeDir);
  assert(lease.leasePath.startsWith(`${canonical.leasesDir}${path.sep}`));
  const observed = await inspectBetaPoolStorage({ homeDir });
  assert.equal(observed.mode, "canonical");
  assert((await fs.lstat(legacy.poolRoot)).isFile());
  assert(
    (
      await fs.lstat(
        path.join(
          canonical.legacyInstancesQuarantineDir,
          "legacy-fixture-operation",
          "journal.json",
        ),
      )
    ).isFile(),
  );
  await fs.chmod(legacy.storage.legacyBetaRoot, 0o000);
  try {
    assert.equal(
      (await inspectBetaPoolStorage({ homeDir })).mode,
      "canonical",
    );
  } finally {
    await fs.chmod(legacy.storage.legacyBetaRoot, 0o700);
  }
  await assert.rejects(
    rollbackBetaPoolStorageMigration({ homeDir }),
    (error) =>
      error?.details?.code === "beta_pool_storage_migration_blocked" &&
      error.details.blockedBy.includes(
        "canonical leases or recovery claims remain",
      ),
  );
  await releaseBetaSlotLease(lease);
  const rollback = await rollbackBetaPoolStorageMigration({ homeDir });
  assert.equal(rollback.state, "rolled_back");
  assert((await fs.lstat(legacy.poolRoot)).isDirectory());
  assert.equal(await fs.lstat(canonical.poolRoot).catch(() => null), null);
}

async function verifyCrashRecovery(root) {
  for (const failpoint of [
    "after_staged",
    "after_canonical_published",
    "after_legacy_archived",
  ]) {
    const homeDir = path.join(root, failpoint);
    await createLegacyMetadata(homeDir);
    process.env.RUNWEAVE_BETA_POOL_MIGRATION_FAILPOINT = failpoint;
    try {
      await assert.rejects(
        acquireBetaSlotLease(leaseOptions(homeDir, `dvs-${failpoint}`)),
        (error) =>
          error?.details?.code === "beta_pool_storage_migration_blocked",
      );
    } finally {
      delete process.env.RUNWEAVE_BETA_POOL_MIGRATION_FAILPOINT;
    }
    assert.equal(
      (await inspectBetaPoolStorage({ homeDir })).mode,
      "migration-resumable",
    );
    const lease = await acquireBetaSlotLease(
      leaseOptions(homeDir, `dvs-${failpoint}-resumed`),
    );
    assert.equal((await inspectBetaPoolStorage({ homeDir })).mode, "canonical");
    await releaseBetaSlotLease(lease);
  }
}

async function verifyConflictAndConcurrency(root) {
  const applicationsDir = path.join(root, "applications");
  const conflictHome = path.join(root, "conflict");
  await Promise.all([
    fs.mkdir(resolveCanonicalBetaPoolPaths(conflictHome).metadataDir, {
      recursive: true,
    }),
    fs.mkdir(resolveLegacyBetaPoolPaths(conflictHome).metadataDir, {
      recursive: true,
    }),
  ]);
  await assert.rejects(
    inspectBetaPool({ homeDir: conflictHome, applicationsDir }),
    (error) => error?.details?.code === "beta_pool_storage_conflict",
  );

  const unsafeHome = path.join(root, "unsafe-migration-root");
  await createLegacyMetadata(unsafeHome);
  const unsafeStorage = resolveBetaPoolStoragePaths(unsafeHome);
  const outside = path.join(root, "outside-migrations");
  await fs.mkdir(unsafeStorage.controlRoot, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.symlink(outside, unsafeStorage.migrationRoot);
  await assert.rejects(
    inspectBetaPool({ homeDir: unsafeHome, applicationsDir }),
    (error) =>
      error?.details?.code === "beta_pool_storage_conflict" &&
      error.details.blockedBy.includes("migration-root-unsafe"),
  );

  const concurrentHome = path.join(root, "concurrent");
  await createLegacyMetadata(concurrentHome);
  const results = await Promise.allSettled([
    prepareBetaPoolStorageForAllocation({ homeDir: concurrentHome }),
    prepareBetaPoolStorageForAllocation({ homeDir: concurrentHome }),
  ]);
  assert(results.some((result) => result.status === "fulfilled"));
  assert(
    results.every(
      (result) =>
        result.status === "fulfilled" ||
        result.reason?.details?.code === "beta_pool_storage_migration_busy",
    ),
  );
  assert.equal(
    (await inspectBetaPoolStorage({ homeDir: concurrentHome })).mode,
    "canonical",
  );
}

export async function verifyBetaPoolStorageMigration(root) {
  await verifyReadOnlyAndDrain(root);
  await verifyMigrationAndRollback(root);
  await verifyCrashRecovery(root);
  await verifyConflictAndConcurrency(root);
}
