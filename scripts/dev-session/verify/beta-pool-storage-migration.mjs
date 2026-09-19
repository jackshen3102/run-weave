import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import {
  acquireBetaSlotLease,
  acquireBetaSlotRecoveryClaim,
  releaseBetaSlotRecoveryClaim,
  inspectBetaPool,
  inspectBetaPoolStorage,
  prepareBetaPoolStorageForAllocation,
  releaseBetaSlotLease,
  resolveBetaPoolStoragePaths,
  resolveCanonicalBetaPoolPaths,
  resolveLegacyBetaPoolPaths,
  rollbackBetaPoolStorageMigration,
} from "../beta-pool/index.mjs";

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

export async function verifyBetaRecoveryClaimTransitions(homeDir) {
  const pool = await prepareBetaPoolStorageForAllocation({ homeDir });
  const slotId = "pool-01";
  const claimPath = path.join(pool.recoveryClaimsDir, `${slotId}.lock`);
  const ownerPath = path.join(claimPath, "owner.json");
  const guardPath = path.join(pool.recoveryClaimsDir, `.${slotId}.transition`);
  const acquire = () => acquireBetaSlotRecoveryClaim(slotId, pool);
  const assertGuardReleased = () =>
    assert.rejects(fs.lstat(guardPath), { code: "ENOENT" });

  // Ambiguous, missing and symlink owner records never imply dead ownership.
  const original = await acquire();
  const ownerBytes = await fs.readFile(ownerPath, "utf8");
  for (const content of [
    "{", "{}", "",
    JSON.stringify({ ...original.claim, processSignature: "unproven-or-old-generation" }),
  ]) {
    await fs.writeFile(ownerPath, content);
    assert.equal(await acquire(), null);
    assert.equal(await fs.readFile(ownerPath, "utf8"), content);
    await assertGuardReleased();
  }
  await fs.rename(ownerPath, path.join(homeDir, "retired-owner.json"));
  assert.equal(await acquire(), null);
  assert((await fs.lstat(claimPath)).isDirectory());
  const externalOwner = path.join(homeDir, "external-owner.json");
  await fs.writeFile(externalOwner, ownerBytes);
  await fs.symlink(externalOwner, ownerPath);
  assert.equal(await acquire(), null);
  assert((await fs.lstat(ownerPath)).isSymbolicLink());
  await assertGuardReleased();
  await fs.rm(ownerPath);
  await fs.writeFile(ownerPath, ownerBytes);
  // Recreating a file cannot restore the original generation's release authority.
  await assert.rejects(
    releaseBetaSlotRecoveryClaim(original, pool),
    /identity drifted/,
  );
  await assertGuardReleased();
  await fs.rm(claimPath, { recursive: true }); // Only this fixture's deliberately corrupted claim.

  // Real child publishes a claim then exits: the original owner is proven dead.
  const moduleUrl = new URL("../beta-pool/index.mjs", import.meta.url);
  const code = `
    import { prepareBetaPoolStorageForAllocation, acquireBetaSlotRecoveryClaim } from ${JSON.stringify(moduleUrl.href)};
    const pool = await prepareBetaPoolStorageForAllocation({homeDir:${JSON.stringify(homeDir)}});
    const claim = await acquireBetaSlotRecoveryClaim(${JSON.stringify(slotId)}, pool);
    process.stdout.write(JSON.stringify(claim.claim));
  `;
  const deadOwner = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      timeout: 15_000,
    }),
  );
  assert.throws(() => process.kill(deadOwner.pid, 0), { code: "ESRCH" });

  // Schedule a real rename, then pause with the canonical name absent. No
  // cooperating successor may publish before the transition guard exits.
  const pauseRename = async (suffix, operation, whilePaused) => {
    const rename = fs.rename;
    let signal;
    let resume;
    const reached = new Promise((resolve) => {
      signal = resolve;
    });
    const barrier = new Promise((resolve) => {
      resume = resolve;
    });
    fs.rename = async (from, to) => {
      await rename(from, to);
      if (from === claimPath && to.endsWith(suffix)) {
        signal();
        await barrier;
      }
    };
    const pending = operation();
    try {
      await Promise.race([
        reached,
        pending.then(() => {
          throw new Error("rename barrier not reached");
        }),
      ]);
      await assert.rejects(fs.lstat(claimPath), { code: "ENOENT" });
      assert((await fs.lstat(guardPath)).isDirectory());
      await whilePaused();
    } finally {
      resume();
      try {
        await pending;
      } finally {
        fs.rename = rename;
      }
    }
    return await pending;
  };
  const recovered = await pauseRename(".stale", acquire, async () => {
    assert.equal(await acquire(), null);
  });
  assert.notEqual(recovered.claim.claimNonce, deadOwner.claimNonce);
  await assertGuardReleased();
  await pauseRename(
    ".released",
    () => releaseBetaSlotRecoveryClaim(recovered, pool),
    async () => {
      assert.equal(await acquire(), null);
    },
  );
  const successor = await acquire();
  const successorBytes = await fs.readFile(ownerPath, "utf8");
  await assert.rejects(
    releaseBetaSlotRecoveryClaim(recovered, pool),
    /identity drifted/,
  );
  assert.equal(await fs.readFile(ownerPath, "utf8"), successorBytes);
  assert.equal(await acquire(), null);
  await assertGuardReleased();

  // An unavailable transition is never reaped, including by bounded release.
  await fs.mkdir(guardPath);
  const guardStats = await fs.lstat(guardPath);
  try {
    assert.equal(await acquire(), null);
    await assert.rejects(
      releaseBetaSlotRecoveryClaim(successor, pool),
      /transition is busy/,
    );
    assert.equal((await fs.lstat(guardPath)).ino, guardStats.ino);
    assert.equal(await fs.readFile(ownerPath, "utf8"), successorBytes);
  } finally {
    await fs.rmdir(guardPath); // This fixture created the guard, not a product resource.
  }
  await releaseBetaSlotRecoveryClaim(successor, pool);
  await assertGuardReleased();

  // Ordinary publish failure must leave neither a transition nor a candidate.
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === claimPath) throw new Error("fixture claim publication failure");
    return await rename(from, to);
  };
  try {
    await assert.rejects(acquire(), /fixture claim publication failure/);
  } finally {
    fs.rename = rename;
  }
  await assertGuardReleased();
  assert.deepEqual(await fs.readdir(pool.recoveryClaimsDir), []);
  const final = await acquire();
  await releaseBetaSlotRecoveryClaim(final, pool);
}

export async function verifyBetaPoolStorageMigration(root) {
  await verifyReadOnlyAndDrain(root);
  await verifyMigrationAndRollback(root);
  await verifyCrashRecovery(root);
  await verifyConflictAndConcurrency(root);
}
