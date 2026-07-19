import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DevSessionError, assertPathInside } from "./contracts.mjs";
import {
  processIdentityMatches,
  readProcessSignature,
} from "./service-runtime.mjs";
import { prepareBetaPoolStorageForAllocation } from "./beta-slot-pool-storage-migration.mjs";
import { resolveEffectiveBetaPoolPaths } from "./beta-slot-pool-storage-paths.mjs";

export const BETA_SLOT_POLICY = "fixed-pool-v1";
export const BETA_SLOT_CAPACITY = 5;
export const BETA_SLOT_IDS = Object.freeze(
  Array.from(
    { length: BETA_SLOT_CAPACITY },
    (_, index) => `pool-${String(index + 1).padStart(2, "0")}`,
  ),
);
export const DEFAULT_BETA_POOL_MIN_FREE_BYTES = 4 * 1024 * 1024 * 1024;
const LEASE_SCHEMA_VERSION = 1;
const RECOVERY_CLAIM_SCHEMA_VERSION = 1;

export function assertBetaSlotId(value) {
  if (!BETA_SLOT_IDS.includes(value)) {
    throw new DevSessionError(
      `Beta dev-session instance must be one of ${BETA_SLOT_IDS.join(", ")}`,
      2,
      { value, allowed: BETA_SLOT_IDS },
    );
  }
  return value;
}

export function resolveBetaPoolPaths(homeDir = os.homedir()) {
  return resolveEffectiveBetaPoolPaths(homeDir);
}

export function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function isPidLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(directory, allowedRoot) {
  const root = path.resolve(allowedRoot);
  const target = assertPathInside(root, directory, "Beta pool directory");
  const existingRoot = await fs.lstat(root).catch((error) => {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (existingRoot?.isSymbolicLink()) {
    throw new DevSessionError("Beta pool root must not be a symlink", 4, {
      path: root,
    });
  }
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStats = await fs.lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new DevSessionError("Beta pool root must not be a symlink", 4, {
      path: root,
    });
  }
  await fs.chmod(root, 0o700);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const relative = path.relative(root, target);
  let current = root;
  for (const component of relative ? relative.split(path.sep) : []) {
    current = path.join(current, component);
    const stats = await fs.lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new DevSessionError("Beta pool path must not contain symlinks", 4, {
        path: current,
      });
    }
    await fs.chmod(current, 0o700);
  }
}

export async function readRegularJson(filePath, allowedRoot) {
  assertPathInside(allowedRoot, filePath, "Beta pool file");
  let handle;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new Error("not a regular file");
    }
    const value = JSON.parse(await handle.readFile("utf8"));
    const named = await fs.lstat(filePath);
    if (named.isSymbolicLink() || !sameFileIdentity(before, named)) {
      throw new Error("file identity changed while reading");
    }
    return { value, stats: named };
  } finally {
    await handle?.close();
  }
}

export async function atomicWriteJson(filePath, value, allowedRoot) {
  const directory = path.dirname(filePath);
  await ensureDirectory(directory, allowedRoot);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  const handle = await fs.open(
    temporaryPath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporaryPath, filePath);
}

function validateRecoveryClaim(value, slotId) {
  if (
    value?.schemaVersion !== RECOVERY_CLAIM_SCHEMA_VERSION ||
    value.slotId !== slotId ||
    typeof value.claimNonce !== "string" ||
    !value.claimNonce ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.processSignature !== "string" ||
    !value.processSignature ||
    typeof value.acquiredAt !== "string" ||
    !Number.isFinite(Date.parse(value.acquiredAt))
  ) {
    throw new DevSessionError("Beta recovery claim is corrupt", 5, {
      slotId,
    });
  }
  return value;
}

export async function acquireBetaSlotRecoveryClaim(slotId, paths) {
  await ensureDirectory(paths.recoveryClaimsDir, paths.poolRoot);
  const claimPath = path.join(paths.recoveryClaimsDir, `${slotId}.lock`);
  for (;;) {
    const claimNonce = randomUUID();
    const candidatePath = path.join(
      paths.recoveryClaimsDir,
      `.${slotId}.${claimNonce}.tmp`,
    );
    const claim = {
      schemaVersion: RECOVERY_CLAIM_SCHEMA_VERSION,
      slotId,
      claimNonce,
      pid: process.pid,
      processSignature: readProcessSignature(process.pid),
      acquiredAt: new Date().toISOString(),
    };
    validateRecoveryClaim(claim, slotId);
    await fs.mkdir(candidatePath, { mode: 0o700 });
    try {
      await atomicWriteJson(
        path.join(candidatePath, "owner.json"),
        claim,
        candidatePath,
      );
      try {
        await fs.rename(candidatePath, claimPath);
        return { claim, claimPath };
      } catch (error) {
        if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") {
          throw error;
        }
      }
    } finally {
      await fs.rm(candidatePath, { recursive: true, force: true });
    }

    const current = await readRegularJson(
      path.join(claimPath, "owner.json"),
      paths.recoveryClaimsDir,
    )
      .then(({ value }) => validateRecoveryClaim(value, slotId))
      .catch(() => null);
    if (
      current &&
      processIdentityMatches({
        pid: current.pid,
        processSignature: current.processSignature,
      })
    ) {
      return null;
    }
    const stalePath = path.join(
      paths.recoveryClaimsDir,
      `.${slotId}.${randomUUID()}.stale`,
    );
    try {
      await fs.rename(claimPath, stalePath);
      await fs.rm(stalePath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

export async function releaseBetaSlotRecoveryClaim(recoveryClaim, paths) {
  const current = validateRecoveryClaim(
    (
      await readRegularJson(
        path.join(recoveryClaim.claimPath, "owner.json"),
        paths.recoveryClaimsDir,
      )
    ).value,
    recoveryClaim.claim.slotId,
  );
  if (current.claimNonce !== recoveryClaim.claim.claimNonce) {
    throw new DevSessionError("Beta recovery claim owner identity drifted", 5, {
      slotId: recoveryClaim.claim.slotId,
    });
  }
  const releasedPath = path.join(
    paths.recoveryClaimsDir,
    `.${current.slotId}.${current.claimNonce}.released`,
  );
  await fs.rename(recoveryClaim.claimPath, releasedPath);
  await fs.rm(releasedPath, { recursive: true, force: true });
}

export function validateBetaSlotLease(value, slotId) {
  const valid =
    value?.schemaVersion === LEASE_SCHEMA_VERSION &&
    value.slotId === slotId &&
    typeof value.leaseNonce === "string" &&
    value.leaseNonce.length > 0 &&
    typeof value.ownerSessionId === "string" &&
    typeof value.ownerSourceRoot === "string" &&
    path.isAbsolute(value.ownerSourceRoot) &&
    typeof value.ownerRevision === "string" &&
    typeof value.ownerManifestPath === "string" &&
    path.isAbsolute(value.ownerManifestPath) &&
    Number.isInteger(value.allocatorPid) &&
    value.allocatorPid > 0 &&
    typeof value.acquiredAt === "string" &&
    Number.isFinite(Date.parse(value.acquiredAt));
  if (!valid) {
    throw new DevSessionError("Beta slot lease is corrupt or unsupported", 5, {
      slotId,
      schemaVersion: value?.schemaVersion ?? null,
    });
  }
  return value;
}

export async function inspectSlot(slotId, paths) {
  const leasePath = path.join(paths.leasesDir, `${slotId}.lock`);
  try {
    const { value } = await readRegularJson(leasePath, paths.poolRoot);
    const lease = validateBetaSlotLease(value, slotId);
    return {
      slotId,
      state: "occupied",
      broken: false,
      ownerSessionId: lease.ownerSessionId,
      ownerManifestPath: lease.ownerManifestPath,
      ownerRevision: lease.ownerRevision,
      allocatorPid: lease.allocatorPid,
      allocatorLive: isPidLive(lease.allocatorPid),
      acquiredAt: lease.acquiredAt,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        slotId,
        state: "idle",
        broken: false,
        ownerSessionId: null,
        acquiredAt: null,
      };
    }
    return {
      slotId,
      state: "broken",
      broken: true,
      ownerSessionId: null,
      acquiredAt: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readMetadata(slotId, paths) {
  try {
    return (
      await readRegularJson(
        path.join(paths.metadataDir, `${slotId}.json`),
        paths.poolRoot,
      )
    ).value;
  } catch {
    return null;
  }
}

export async function inspectBetaPoolRootSafety(paths) {
  for (const directory of [paths.betaRoot, paths.poolRoot, paths.leasesDir]) {
    const stats = await fs.lstat(directory).catch((error) => {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (stats && (!stats.isDirectory() || stats.isSymbolicLink())) {
      return `Beta pool ownership path is unsafe: ${directory}`;
    }
  }
  return null;
}

export async function inspectBetaSlotCapacity({ homeDir = os.homedir() } = {}) {
  const paths = resolveBetaPoolPaths(homeDir);
  const rootFailure = await inspectBetaPoolRootSafety(paths);
  const slots = rootFailure
    ? BETA_SLOT_IDS.map((slotId) => ({
        slotId,
        state: "broken",
        broken: true,
        ownerSessionId: null,
        acquiredAt: null,
        reason: rootFailure,
      }))
    : await Promise.all(
        BETA_SLOT_IDS.map((slotId) => inspectSlot(slotId, paths)),
      );
  return {
    authoritative: false,
    observedAt: new Date().toISOString(),
    capacity: BETA_SLOT_CAPACITY,
    idle: slots.filter((slot) => slot.state === "idle").length,
    occupied: slots.filter((slot) => slot.state === "occupied").length,
    broken: slots.filter((slot) => slot.state === "broken").length,
    slots,
  };
}

function sortSlotCandidates(candidates, metadata, revision) {
  return [...candidates].sort((left, right) => {
    const leftMetadata = metadata.get(left.slotId);
    const rightMetadata = metadata.get(right.slotId);
    const leftRevisionMatch = leftMetadata?.lastRevision === revision ? 0 : 1;
    const rightRevisionMatch = rightMetadata?.lastRevision === revision ? 0 : 1;
    if (leftRevisionMatch !== rightRevisionMatch) {
      return leftRevisionMatch - rightRevisionMatch;
    }
    const leftReleased = Date.parse(leftMetadata?.lastReleasedAt ?? "") || 0;
    const rightReleased = Date.parse(rightMetadata?.lastReleasedAt ?? "") || 0;
    return (
      leftReleased - rightReleased || left.slotId.localeCompare(right.slotId)
    );
  });
}

async function publishLease(paths, lease) {
  await ensureDirectory(paths.leasesDir, paths.poolRoot);
  const leasePath = path.join(paths.leasesDir, `${lease.slotId}.lock`);
  const candidatePath = path.join(
    paths.leasesDir,
    `.${lease.slotId}.${lease.leaseNonce}.tmp`,
  );
  let handle;
  let candidateStats;
  let published = false;
  try {
    handle = await fs.open(
      candidatePath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`, "utf8");
    await handle.sync();
    candidateStats = await handle.stat();
    await handle.close();
    handle = null;
    const namedCandidate = await fs.lstat(candidatePath);
    if (
      namedCandidate.isSymbolicLink() ||
      !sameFileIdentity(candidateStats, namedCandidate)
    ) {
      throw new DevSessionError("Beta lease candidate identity changed", 5, {
        slotId: lease.slotId,
      });
    }
    await fs.link(candidatePath, leasePath);
    published = true;
    const publishedStats = await fs.lstat(leasePath);
    if (
      publishedStats.isSymbolicLink() ||
      !sameFileIdentity(candidateStats, publishedStats)
    ) {
      throw new DevSessionError("Beta lease publish identity changed", 5, {
        slotId: lease.slotId,
      });
    }
    await fs.rm(candidatePath);
    return { leasePath, leaseStats: publishedStats };
  } catch (error) {
    await handle?.close();
    await fs.rm(candidatePath, { force: true }).catch(() => undefined);
    if (published && candidateStats) {
      const current = await fs.lstat(leasePath).catch(() => null);
      if (current && sameFileIdentity(current, candidateStats)) {
        await fs.rm(leasePath).catch(() => undefined);
      }
    }
    if (error?.code === "EEXIST") {
      return null;
    }
    throw error;
  }
}

export async function acquireBetaSlotLease({
  requestedSlotId = null,
  ownerSessionId,
  ownerSourceRoot,
  ownerRevision,
  ownerManifestPath,
  homeDir = os.homedir(),
}) {
  if (requestedSlotId !== null) {
    assertBetaSlotId(requestedSlotId);
  }
  const paths = await prepareBetaPoolStorageForAllocation({ homeDir });
  await ensureDirectory(paths.poolRoot, paths.betaRoot);
  await ensureDirectory(paths.leasesDir, paths.poolRoot);
  await ensureDirectory(paths.metadataDir, paths.poolRoot);
  const snapshot = await inspectBetaSlotCapacity({ homeDir });
  const metadata = new Map(
    await Promise.all(
      BETA_SLOT_IDS.map(async (slotId) => [
        slotId,
        await readMetadata(slotId, paths),
      ]),
    ),
  );
  let candidates;
  if (requestedSlotId) {
    const requested = snapshot.slots.find(
      (slot) => slot.slotId === requestedSlotId,
    );
    candidates = requested?.state === "idle" ? [requested] : [];
  } else {
    candidates = sortSlotCandidates(
      snapshot.slots.filter((slot) => slot.state === "idle"),
      metadata,
      ownerRevision,
    );
  }
  for (const candidate of candidates) {
    const lease = {
      schemaVersion: LEASE_SCHEMA_VERSION,
      slotId: candidate.slotId,
      leaseNonce: randomUUID(),
      ownerSessionId,
      ownerSourceRoot: path.resolve(ownerSourceRoot),
      ownerRevision,
      ownerManifestPath: path.resolve(ownerManifestPath),
      allocatorPid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    const published = await publishLease(paths, lease);
    if (published) {
      return { ...published, lease, paths, homeDir };
    }
    if (requestedSlotId) {
      break;
    }
  }
  const current = await inspectBetaSlotCapacity({ homeDir });
  throw new DevSessionError(
    requestedSlotId
      ? `requested Beta slot is occupied or broken: ${requestedSlotId}`
      : "all five Beta slots are occupied or broken",
    5,
    {
      requestedSlotId,
      capacity: BETA_SLOT_CAPACITY,
      slots: current.slots,
      recovery:
        "Stop the owning dev session shown for an occupied slot; inspect broken leases before manual recovery.",
    },
  );
}

export async function assertBetaSlotLease({
  slotId,
  ownerSessionId,
  leaseNonce,
  homeDir = os.homedir(),
}) {
  assertBetaSlotId(slotId);
  const paths = resolveBetaPoolPaths(homeDir);
  const leasePath = path.join(paths.leasesDir, `${slotId}.lock`);
  let read;
  try {
    read = await readRegularJson(leasePath, paths.poolRoot);
  } catch (error) {
    throw new DevSessionError("Beta slot lease is missing or unreadable", 5, {
      slotId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const lease = validateBetaSlotLease(read.value, slotId);
  if (
    lease.ownerSessionId !== ownerSessionId ||
    lease.leaseNonce !== leaseNonce
  ) {
    throw new DevSessionError("Beta slot lease owner identity drifted", 5, {
      slotId,
      expectedOwnerSessionId: ownerSessionId,
      actualOwnerSessionId: lease.ownerSessionId,
    });
  }
  return { lease, leasePath, leaseStats: read.stats, paths };
}

export async function releaseBetaSlotLease(identity) {
  const verified = await assertBetaSlotLease({
    slotId: identity.slotId ?? identity.lease?.slotId,
    ownerSessionId: identity.ownerSessionId ?? identity.lease?.ownerSessionId,
    leaseNonce: identity.leaseNonce ?? identity.lease?.leaseNonce,
    homeDir: identity.homeDir,
  });
  const current = await fs.lstat(verified.leasePath);
  if (!sameFileIdentity(current, verified.leaseStats)) {
    throw new DevSessionError("Beta slot lease file identity drifted", 5, {
      slotId: verified.lease.slotId,
    });
  }
  await fs.rm(verified.leasePath);
}
