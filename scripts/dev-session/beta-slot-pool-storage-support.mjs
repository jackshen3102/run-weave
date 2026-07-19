import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { DevSessionError } from "./contracts.mjs";
import {
  resolveBetaPoolStoragePaths,
  resolveLegacyBetaPoolPaths,
} from "./beta-slot-pool-storage-paths.mjs";
import {
  processIdentityMatches,
  readProcessSignature,
} from "./service-runtime.mjs";

export const STORAGE_SCHEMA_VERSION = 1;
export const STORAGE_KIND = "beta-pool-control-plane-v1";

export async function lstat(filePath) {
  return await fs.lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return null;
    }
    throw error;
  });
}

export async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporaryPath, filePath);
}

export async function ensureSafeDirectory(directory) {
  const existing = await lstat(directory);
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
    throw new Error(`migration directory is unsafe: ${directory}`);
  }
  if (!existing) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const created = await fs.lstat(directory);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    throw new Error(`migration directory is unsafe: ${directory}`);
  }
  await fs.chmod(directory, 0o700);
}

export async function directoryEntries(directory) {
  const stats = await lstat(directory);
  if (!stats) {
    return [];
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return null;
  }
  return await fs.readdir(directory);
}

export async function inspectLegacyActivity(paths) {
  const leaseEntries = await directoryEntries(paths.leasesDir);
  const recoveryClaimEntries = await directoryEntries(paths.recoveryClaimsDir);
  const blockers = [];
  const owners = [];
  if (leaseEntries === null) {
    blockers.push("legacy-leases-path-unsafe");
  } else {
    for (const entry of leaseEntries) {
      blockers.push(`legacy-lease:${entry}`);
      const lease = await readJson(path.join(paths.leasesDir, entry));
      if (lease?.ownerSessionId) {
        owners.push({
          slotId: lease.slotId ?? entry.replace(/\.lock$/, ""),
          ownerSessionId: lease.ownerSessionId,
        });
      }
    }
  }
  if (recoveryClaimEntries === null) {
    blockers.push("legacy-recovery-claims-path-unsafe");
  } else {
    blockers.push(
      ...recoveryClaimEntries.map((entry) => `legacy-recovery-claim:${entry}`),
    );
  }
  return { blockers, owners };
}

function storageDetails(storage, mode, blockedBy, extra = {}) {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    mode,
    effectiveRoot:
      mode === "legacy-draining"
        ? storage.legacyPoolRoot
        : mode === "uninitialized" || mode === "canonical"
          ? storage.canonicalPoolRoot
          : null,
    canonicalRoot: storage.canonicalPoolRoot,
    legacyRoot: storage.legacyPoolRoot,
    migrationRequired:
      mode === "legacy-draining" || mode === "migration-resumable",
    blockedBy,
    ...extra,
  };
}

function isMigrationTombstone(value) {
  return (
    value?.schemaVersion === STORAGE_SCHEMA_VERSION &&
    value.state === "migrated" &&
    typeof value.migrationId === "string" &&
    typeof value.backupPath === "string"
  );
}

export async function inspectBetaPoolStorage({ homeDir } = {}) {
  const storage = resolveBetaPoolStoragePaths(homeDir);
  const canonicalStats = await lstat(storage.canonicalPoolRoot);
  const canonicalDirectory = canonicalStats?.isDirectory() ?? false;
  const canonicalMarker = canonicalDirectory
    ? await readJson(path.join(storage.canonicalPoolRoot, "storage.json"))
    : null;

  if (canonicalStats?.isSymbolicLink()) {
    return storageDetails(storage, "conflict", ["canonical-root-symlink"]);
  }
  if (canonicalStats && !canonicalDirectory) {
    return storageDetails(storage, "conflict", [
      "canonical-root-not-directory",
    ]);
  }
  if (
    canonicalMarker?.schemaVersion === STORAGE_SCHEMA_VERSION &&
    canonicalMarker.storage === STORAGE_KIND &&
    canonicalMarker.completedAt
  ) {
    return storageDetails(storage, "canonical", [], {
      migration: canonicalMarker.migrationId
        ? {
            migrationId: canonicalMarker.migrationId,
            backupPath: canonicalMarker.backupPath,
            completedAt: canonicalMarker.completedAt,
          }
        : null,
    });
  }

  const legacyStats = await lstat(storage.legacyPoolRoot);
  const legacyDirectory = legacyStats?.isDirectory() ?? false;
  const legacyTombstone = legacyStats?.isFile()
    ? await readJson(storage.legacyPoolRoot)
    : null;
  const pendingMigrations = await findPendingMigrations(storage);
  const migrationRootStats = await lstat(storage.migrationRoot);

  if (legacyStats?.isSymbolicLink()) {
    return storageDetails(storage, "conflict", ["legacy-root-symlink"]);
  }
  if (
    migrationRootStats?.isSymbolicLink() ||
    (migrationRootStats && !migrationRootStats.isDirectory())
  ) {
    return storageDetails(storage, "conflict", ["migration-root-unsafe"]);
  }
  if (
    canonicalDirectory &&
    canonicalMarker?.storage === STORAGE_KIND &&
    canonicalMarker.migrationId &&
    !canonicalMarker.completedAt
  ) {
    return storageDetails(storage, "migration-resumable", [], {
      migrationId: canonicalMarker.migrationId,
    });
  }
  if (canonicalDirectory && legacyDirectory) {
    return storageDetails(storage, "conflict", [
      "canonical-and-legacy-roots-both-directories",
    ]);
  }
  if (canonicalDirectory) {
    if (legacyStats && !isMigrationTombstone(legacyTombstone)) {
      return storageDetails(storage, "conflict", [
        "legacy-root-is-not-migration-tombstone",
      ]);
    }
    return storageDetails(storage, "canonical", [], {
      markerMissing: canonicalMarker?.storage !== STORAGE_KIND,
      migration: isMigrationTombstone(legacyTombstone)
        ? {
            migrationId: legacyTombstone.migrationId,
            backupPath: legacyTombstone.backupPath,
            completedAt: legacyTombstone.completedAt ?? null,
          }
        : null,
    });
  }
  if (legacyDirectory) {
    if (pendingMigrations.length === 1) {
      return storageDetails(storage, "migration-resumable", [], {
        migrationId: pendingMigrations[0].migrationId,
      });
    }
    if (pendingMigrations.length > 1) {
      return storageDetails(storage, "conflict", [
        "multiple-pending-migrations",
      ]);
    }
    const activity = await inspectLegacyActivity(
      resolveLegacyBetaPoolPaths(homeDir),
    );
    return storageDetails(storage, "legacy-draining", activity.blockers, {
      legacyOwners: activity.owners,
    });
  }
  if (legacyStats) {
    return storageDetails(storage, "conflict", [
      isMigrationTombstone(legacyTombstone)
        ? "canonical-root-missing-after-migration"
        : "legacy-root-not-directory",
    ]);
  }
  return storageDetails(storage, "uninitialized", []);
}

export async function findPendingMigrations(storage) {
  const entries = await directoryEntries(storage.migrationRoot);
  if (!Array.isArray(entries)) {
    return [];
  }
  const pending = [];
  for (const entry of entries) {
    const journalPath = path.join(storage.migrationRoot, entry, "journal.json");
    const journal = await readJson(journalPath);
    if (
      journal?.schemaVersion === 1 &&
      journal.migrationId === entry &&
      !["completed", "rolled_back"].includes(journal.state)
    ) {
      pending.push(journal);
    }
  }
  return pending;
}

export function migrationError(
  message,
  code,
  storage,
  blockedBy,
  extra = {},
) {
  return new DevSessionError(message, 5, {
    code,
    canonicalRoot: storage.canonicalRoot,
    legacyRoot: storage.legacyRoot,
    mode: storage.mode,
    blockedBy,
    ...extra,
  });
}

export async function fingerprintTree(root) {
  const digest = createHash("sha256");
  async function visit(current, relative) {
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`migration source contains symlink: ${current}`);
    }
    if (stats.isDirectory()) {
      digest.update(`d\0${relative}\0${stats.mode & 0o777}\n`);
      const entries = (await fs.readdir(current)).sort();
      for (const entry of entries) {
        await visit(path.join(current, entry), path.join(relative, entry));
      }
      return;
    }
    if (!stats.isFile()) {
      throw new Error(`migration source contains unsupported file: ${current}`);
    }
    digest.update(`f\0${relative}\0${stats.mode & 0o777}\0`);
    digest.update(await fs.readFile(current));
    digest.update("\n");
  }
  const stats = await lstat(root);
  if (!stats) {
    return createHash("sha256").update("empty").digest("hex");
  }
  await visit(root, "");
  return digest.digest("hex");
}

export async function copyLegacyData(source, staging) {
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  const metadataSource = path.join(source, "metadata");
  const metadataTarget = path.join(staging, "metadata");
  if (await lstat(metadataSource)) {
    await fs.cp(metadataSource, metadataTarget, {
      recursive: true,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    if (
      (await fingerprintTree(metadataSource)) !==
      (await fingerprintTree(metadataTarget))
    ) {
      throw new Error("Beta pool metadata copy verification failed");
    }
  }
  const quarantineSource = path.join(source, "quarantine");
  if (await lstat(quarantineSource)) {
    for (const entry of await fs.readdir(quarantineSource)) {
      const sourcePath = path.join(quarantineSource, entry);
      const targetPath = path.join(
        staging,
        "quarantine",
        entry.startsWith("legacy-") ? "legacy-instances" : "",
        entry,
      );
      await fs.mkdir(path.dirname(targetPath), {
        recursive: true,
        mode: 0o700,
      });
      await fs.cp(sourcePath, targetPath, {
        recursive: true,
        errorOnExist: true,
        preserveTimestamps: true,
      });
      if (
        (await fingerprintTree(sourcePath)) !==
        (await fingerprintTree(targetPath))
      ) {
        throw new Error(
          `Beta pool quarantine copy verification failed: ${entry}`,
        );
      }
    }
  }
  await Promise.all(
    ["leases", "recovery-claims", "metadata", "quarantine"].map((entry) =>
      fs.mkdir(path.join(staging, entry), { recursive: true, mode: 0o700 }),
    ),
  );
}

export async function acquireMigrationLock(lockPath) {
  const owner = {
    schemaVersion: 1,
    pid: process.pid,
    processSignature: readProcessSignature(process.pid),
    nonce: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  for (;;) {
    const candidatePath = `${lockPath}.${owner.nonce}.candidate`;
    try {
      await fs.mkdir(candidatePath, { mode: 0o700 });
      await atomicWriteJson(path.join(candidatePath, "owner.json"), owner);
      await fs.rename(candidatePath, lockPath);
      return owner;
    } catch (error) {
      await fs.rm(candidatePath, { recursive: true, force: true });
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") {
        throw error;
      }
    }
    const current = await readJson(path.join(lockPath, "owner.json"));
    if (
      current &&
      processIdentityMatches({
        pid: current.pid,
        processSignature: current.processSignature,
      })
    ) {
      return null;
    }
    const stalePath = `${lockPath}.${randomUUID()}.stale`;
    try {
      await fs.rename(lockPath, stalePath);
      await fs.rm(stalePath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

export async function releaseMigrationLock(lockPath, owner) {
  const current = await readJson(path.join(lockPath, "owner.json"));
  if (current?.nonce !== owner.nonce) {
    throw new Error("Beta pool migration lock owner drifted");
  }
  await fs.rm(lockPath, { recursive: true });
}
