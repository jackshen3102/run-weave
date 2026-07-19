import { lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function isDirectory(filePath) {
  try {
    return lstatSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function buildPoolPaths(root, betaRoot, extra = {}) {
  return {
    ...extra,
    betaRoot,
    poolRoot: root,
    leasesDir: path.join(root, "leases"),
    recoveryClaimsDir: path.join(root, "recovery-claims"),
    metadataDir: path.join(root, "metadata"),
    quarantineDir: path.join(root, "quarantine"),
    legacyInstancesQuarantineDir: path.join(
      root,
      "quarantine",
      "legacy-instances",
    ),
  };
}

export function resolveBetaPoolStoragePaths(homeDir = os.homedir()) {
  const controlRoot = path.join(homeDir, ".runweave");
  const canonicalPoolRoot = path.join(controlRoot, "beta-pool");
  const legacyBetaRoot = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Runweave Beta",
  );
  const legacyPoolRoot = path.join(legacyBetaRoot, "pool");
  return {
    homeDir,
    controlRoot,
    canonicalPoolRoot,
    legacyBetaRoot,
    legacyPoolRoot,
    migrationRoot: path.join(controlRoot, "beta-pool-migrations"),
    migrationLockPath: path.join(controlRoot, ".beta-pool-migration.lock"),
  };
}

export function resolveCanonicalBetaPoolPaths(homeDir = os.homedir()) {
  const storage = resolveBetaPoolStoragePaths(homeDir);
  return buildPoolPaths(storage.canonicalPoolRoot, storage.controlRoot, {
    storageKind: "canonical",
    storage,
  });
}

export function resolveLegacyBetaPoolPaths(homeDir = os.homedir()) {
  const storage = resolveBetaPoolStoragePaths(homeDir);
  return buildPoolPaths(storage.legacyPoolRoot, storage.legacyBetaRoot, {
    storageKind: "legacy",
    storage,
  });
}

export function resolveEffectiveBetaPoolPaths(homeDir = os.homedir()) {
  const canonical = resolveCanonicalBetaPoolPaths(homeDir);
  const legacy = resolveLegacyBetaPoolPaths(homeDir);
  if (isDirectory(canonical.poolRoot)) {
    return canonical;
  }
  if (isDirectory(legacy.poolRoot)) {
    return legacy;
  }
  return canonical;
}
