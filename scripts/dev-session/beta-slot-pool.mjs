import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { resolveBetaUpdateTargets } from "../runweave-update-core.mjs";
import {
  inspectProcessReferences,
  inspectRecordedProcessState,
} from "../runweave-beta-state.mjs";
import { DevSessionError, assertPathInside } from "./contracts.mjs";
import {
  processIdentityMatches,
  readProcessSignature,
} from "./service-runtime.mjs";
import { stopOwnedProcess } from "./shared-services.mjs";

const execFileAsync = promisify(execFile);

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
const MAX_UPDATE_LOGS = 5;
const MAX_UPDATE_LOG_BYTES = 64 * 1024 * 1024;
const MIN_PLANNED_WRITE_BYTES = 512 * 1024 * 1024;
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
  const betaRoot = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Runweave Beta",
  );
  const poolRoot = path.join(betaRoot, "pool");
  return {
    betaRoot,
    poolRoot,
    leasesDir: path.join(poolRoot, "leases"),
    recoveryClaimsDir: path.join(poolRoot, "recovery-claims"),
    metadataDir: path.join(poolRoot, "metadata"),
    quarantineDir: path.join(poolRoot, "quarantine"),
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function isPidLive(pid) {
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

async function readRegularJson(filePath, allowedRoot) {
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

async function atomicWriteJson(filePath, value, allowedRoot) {
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

async function acquireBetaSlotRecoveryClaim(slotId, paths) {
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

async function releaseBetaSlotRecoveryClaim(recoveryClaim, paths) {
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

function validateLease(value, slotId) {
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

async function inspectSlot(slotId, paths) {
  const leasePath = path.join(paths.leasesDir, `${slotId}.lock`);
  try {
    const { value } = await readRegularJson(leasePath, paths.poolRoot);
    const lease = validateLease(value, slotId);
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

async function inspectPoolRootSafety(paths) {
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
  const rootFailure = await inspectPoolRootSafety(paths);
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
  const paths = resolveBetaPoolPaths(homeDir);
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
  const lease = validateLease(read.value, slotId);
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

async function calculatePathBytes(targetPath, rejectSymlink = true) {
  const stats = await fs.lstat(targetPath).catch((error) => {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!stats) {
    return 0;
  }
  if (stats.isSymbolicLink()) {
    if (rejectSymlink) {
      throw new DevSessionError("refusing to size a symlinked Beta path", 4, {
        path: targetPath,
      });
    }
    return stats.size;
  }
  if (!stats.isDirectory()) {
    return stats.size;
  }
  let bytes = 0;
  for (const entry of await fs.readdir(targetPath)) {
    bytes += await calculatePathBytes(path.join(targetPath, entry), false);
  }
  return bytes;
}

async function nearestExistingPath(targetPath) {
  let candidate = path.resolve(targetPath);
  while (!(await fs.lstat(candidate).catch(() => null))) {
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw new DevSessionError(
        "cannot resolve filesystem for Beta target",
        4,
        {
          path: targetPath,
        },
      );
    }
    candidate = parent;
  }
  return candidate;
}

async function calculateTrackedSourceBytes(sourceRoot) {
  const { stdout } = await execFileAsync(
    "git",
    [
      "ls-files",
      "-z",
      "--",
      "electron",
      "app-server",
      "frontend",
      "backend",
      "packages/common",
      "packages/shared",
      "packages/terminal-renderer",
      "packages/runweave-cli",
      "scripts",
    ],
    { cwd: sourceRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  let bytes = 0;
  for (const relativePath of stdout.split("\0").filter(Boolean)) {
    const filePath = assertPathInside(
      sourceRoot,
      path.join(sourceRoot, relativePath),
    );
    const stats = await fs.lstat(filePath);
    bytes += stats.size;
  }
  return bytes;
}

export async function assertBetaPoolDiskBudget({
  sourceRoot,
  slotId,
  homeDir = os.homedir(),
  applicationsDir = "/Applications",
  env = process.env,
  cleanedBytes = 0,
}) {
  const targets = resolveBetaUpdateTargets(homeDir, assertBetaSlotId(slotId));
  const appPath = path.join(applicationsDir, path.basename(targets.appPath));
  const configured = env.RUNWEAVE_BETA_POOL_MIN_FREE_BYTES?.trim();
  const configuredFloor = configured
    ? Number(configured)
    : DEFAULT_BETA_POOL_MIN_FREE_BYTES;
  if (!Number.isSafeInteger(configuredFloor) || configuredFloor < 0) {
    throw new DevSessionError(
      "RUNWEAVE_BETA_POOL_MIN_FREE_BYTES must be a non-negative integer",
      2,
      { value: configured ?? null },
    );
  }
  const estimates = await Promise.all([
    calculatePathBytes(appPath),
    calculatePathBytes(targets.runtimeHome),
    calculatePathBytes(path.join(targets.appServerHome, "runtime")),
    calculateTrackedSourceBytes(sourceRoot),
  ]);
  const existingBytes = estimates[0] + estimates[1] + estimates[2];
  const plannedWriteBytes = Math.max(
    estimates.reduce((total, estimate) => total + estimate, 0),
    MIN_PLANNED_WRITE_BYTES,
  );
  if (!Number.isSafeInteger(plannedWriteBytes) || plannedWriteBytes <= 0) {
    throw new DevSessionError(
      "unable to estimate Beta pool planned writes",
      5,
      {
        slotId,
        estimates,
      },
    );
  }
  const requiredFreeBytes = Math.max(configuredFloor, plannedWriteBytes * 3);
  const filesystemPaths = await Promise.all([
    nearestExistingPath(appPath),
    nearestExistingPath(targets.instanceRoot),
    nearestExistingPath(targets.appServerHome),
  ]);
  const freeBytesByPath = await Promise.all(
    filesystemPaths.map(async (filesystemPath) => {
      const stats = await fs.statfs(filesystemPath);
      return {
        path: filesystemPath,
        freeBytes: stats.bavail * stats.bsize,
      };
    }),
  );
  const freeBytes = Math.min(
    ...freeBytesByPath.map((entry) => entry.freeBytes),
  );
  const summary = {
    slotId,
    freeBytes,
    requiredFreeBytes,
    configuredFloor,
    plannedWriteBytes,
    cleanedBytes,
    retainedBytes: existingBytes,
    filesystems: freeBytesByPath,
  };
  if (freeBytes < requiredFreeBytes) {
    throw new DevSessionError(
      "insufficient disk space for Beta slot start",
      5,
      {
        diskSummary: summary,
      },
    );
  }
  return summary;
}

async function validateReleaseAllowlist(runtimeHome, previousReleaseId) {
  const pointerPath = path.join(runtimeHome, "current.json");
  const releasesDir = path.join(runtimeHome, "releases");
  const pointerExists = await fs.lstat(pointerPath).catch(() => null);
  const releasesExist = await fs.lstat(releasesDir).catch(() => null);
  if (!pointerExists && !releasesExist) {
    return new Set();
  }
  if (
    !pointerExists ||
    pointerExists.isSymbolicLink() ||
    !pointerExists.isFile()
  ) {
    throw new DevSessionError(
      "runtime current pointer is missing or unsafe",
      5,
      {
        runtimeHome,
      },
    );
  }
  const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8"));
  if (
    typeof pointer.releaseId !== "string" ||
    !pointer.releaseId ||
    pointer.releaseId.includes("/") ||
    pointer.releaseId.includes("..")
  ) {
    throw new DevSessionError("runtime current pointer is corrupt", 5, {
      runtimeHome,
    });
  }
  const allowlist = new Set([pointer.releaseId]);
  if (previousReleaseId) {
    allowlist.add(previousReleaseId);
  }
  for (const releaseId of allowlist) {
    const releasePath = path.join(releasesDir, releaseId);
    const stats = await fs.lstat(releasePath).catch(() => null);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
      throw new DevSessionError(
        "runtime pointer references a missing release",
        5,
        {
          runtimeHome,
          releaseId,
        },
      );
    }
  }
  return allowlist;
}

async function pruneRuntime(runtimeHome, previousReleaseId, validated = null) {
  const releasesDir = path.join(runtimeHome, "releases");
  const allowlist =
    validated ??
    (await validateReleaseAllowlist(runtimeHome, previousReleaseId));
  let cleanedBytes = 0;
  for (const entry of await fs.readdir(releasesDir).catch(() => [])) {
    if (allowlist.has(entry)) {
      continue;
    }
    const target = path.join(releasesDir, entry);
    cleanedBytes += await calculatePathBytes(target);
    await fs.rm(target, { recursive: true, force: true });
  }
  return { retainedReleaseIds: [...allowlist], cleanedBytes };
}

async function pruneLogs(logDir) {
  const entries = [];
  for (const entry of await fs.readdir(logDir).catch(() => [])) {
    const filePath = path.join(logDir, entry);
    const stats = await fs.lstat(filePath);
    if (stats.isFile() && !stats.isSymbolicLink()) {
      entries.push({ filePath, mtimeMs: stats.mtimeMs, size: stats.size });
    }
  }
  entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
  let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  let cleanedBytes = 0;
  while (
    entries.length > MAX_UPDATE_LOGS ||
    totalBytes > MAX_UPDATE_LOG_BYTES
  ) {
    const removed = entries.shift();
    await fs.rm(removed.filePath);
    totalBytes -= removed.size;
    cleanedBytes += removed.size;
  }
  return { count: entries.length, bytes: totalBytes, cleanedBytes };
}

export async function applyBetaSlotRetention({
  slotId,
  homeDir = os.homedir(),
  applicationsDir = "/Applications",
}) {
  const targets = resolveBetaUpdateTargets(homeDir, assertBetaSlotId(slotId));
  await assertNoSymlinkComponents(homeDir, targets.runtimeHome);
  await assertNoSymlinkComponents(
    path.join(homeDir, ".runweave"),
    path.join(targets.appServerHome, "runtime"),
  );
  const stateStats = await fs.lstat(targets.statePath).catch(() => null);
  let state = null;
  if (stateStats) {
    if (!stateStats.isFile() || stateStats.isSymbolicLink()) {
      throw new DevSessionError("Beta warm-state pointer is unsafe", 5, {
        slotId,
        statePath: targets.statePath,
      });
    }
    try {
      state = JSON.parse(await fs.readFile(targets.statePath, "utf8"));
    } catch {
      throw new DevSessionError("Beta warm-state pointer is corrupt", 5, {
        slotId,
        statePath: targets.statePath,
      });
    }
  }
  const desktopPrevious = state?.previous?.runtimeReleaseId ?? null;
  const appServerPrevious = state?.previous?.appServerReleaseId ?? null;
  const [desktopAllowlist, appServerAllowlist] = await Promise.all([
    validateReleaseAllowlist(targets.runtimeHome, desktopPrevious),
    validateReleaseAllowlist(
      path.join(targets.appServerHome, "runtime"),
      appServerPrevious,
    ),
  ]);
  const referencedBackup = state?.previous?.app?.backupPath ?? null;
  const backupPrefix = `.${targets.appName}.app.previous`;
  const backupPaths = (await fs.readdir(applicationsDir).catch(() => []))
    .filter((entry) => entry.startsWith(backupPrefix))
    .map((entry) => path.join(applicationsDir, entry));
  if (backupPaths.length > 0 && !referencedBackup) {
    throw new DevSessionError("Beta app previous pointer is missing", 5, {
      slotId,
      backups: backupPaths,
    });
  }
  if (
    referencedBackup &&
    state?.previous?.app?.exists === true &&
    (!backupPaths.includes(path.resolve(referencedBackup)) ||
      !path.basename(referencedBackup).startsWith(backupPrefix))
  ) {
    throw new DevSessionError("Beta app previous pointer is invalid", 5, {
      slotId,
      referencedBackup,
    });
  }
  const [desktopRuntime, appServerRuntime, logs] = await Promise.all([
    pruneRuntime(targets.runtimeHome, desktopPrevious, desktopAllowlist),
    pruneRuntime(
      path.join(targets.appServerHome, "runtime"),
      appServerPrevious,
      appServerAllowlist,
    ),
    pruneLogs(path.join(targets.instanceRoot, "diagnostics", "logs")),
  ]);
  let appBackupCleanedBytes = 0;
  for (const backupPath of backupPaths) {
    if (
      referencedBackup &&
      path.resolve(backupPath) === path.resolve(referencedBackup)
    ) {
      continue;
    }
    appBackupCleanedBytes += await calculatePathBytes(backupPath);
    await fs.rm(backupPath, { recursive: true, force: true });
  }
  return {
    desktopRuntime,
    appServerRuntime,
    logs,
    appBackupCleanedBytes,
    cleanedBytes:
      desktopRuntime.cleanedBytes +
      appServerRuntime.cleanedBytes +
      logs.cleanedBytes +
      appBackupCleanedBytes,
  };
}

async function assertSafeMutableRoot(targetPath, allowedRoot) {
  const resolved = assertPathInside(
    allowedRoot,
    targetPath,
    "Beta mutable path",
  );
  const stats = await fs.lstat(resolved).catch(() => null);
  if (stats?.isSymbolicLink()) {
    throw new DevSessionError("Beta mutable path must not be a symlink", 5, {
      path: resolved,
    });
  }
  return resolved;
}

async function assertNoSymlinkComponents(rootPath, targetPath) {
  const root = path.resolve(rootPath);
  const target = assertPathInside(root, targetPath, "Beta controlled path");
  const rootStats = await fs.lstat(root).catch((error) => {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (rootStats?.isSymbolicLink()) {
    throw new DevSessionError("Beta controlled root is a symlink", 5, {
      path: root,
    });
  }
  let current = root;
  for (const component of path.relative(root, target).split(path.sep)) {
    if (!component) {
      continue;
    }
    current = path.join(current, component);
    const stats = await fs.lstat(current).catch((error) => {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!stats) {
      return;
    }
    if (stats.isSymbolicLink()) {
      throw new DevSessionError("Beta controlled path contains a symlink", 5, {
        path: current,
      });
    }
  }
}

export async function resetBetaSlotMutableState({
  slotId,
  homeDir = os.homedir(),
  afterUserDataSwap = null,
}) {
  const targets = resolveBetaUpdateTargets(homeDir, assertBetaSlotId(slotId));
  await assertNoSymlinkComponents(homeDir, targets.instanceRoot);
  await assertNoSymlinkComponents(
    path.join(homeDir, ".runweave"),
    targets.appServerHome,
  );
  const userData = await assertSafeMutableRoot(
    targets.userData,
    targets.instanceRoot,
  );
  await fs.mkdir(targets.instanceRoot, { recursive: true, mode: 0o700 });
  const resetPath = path.join(
    targets.instanceRoot,
    `.user-data.reset-${randomUUID()}`,
  );
  if (await fs.lstat(userData).catch(() => null)) {
    await fs.rename(userData, resetPath);
  }
  await fs.mkdir(userData, { recursive: true, mode: 0o700 });
  await afterUserDataSwap?.();
  await fs.rm(resetPath, { recursive: true, force: true });
  for (const entry of await fs.readdir(targets.instanceRoot)) {
    if (entry.startsWith(".user-data.reset-")) {
      await fs.rm(path.join(targets.instanceRoot, entry), {
        recursive: true,
        force: true,
      });
    }
  }

  const appServerHome = await assertSafeMutableRoot(
    targets.appServerHome,
    path.join(homeDir, ".runweave", "app-server-beta"),
  );
  await fs.mkdir(appServerHome, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(appServerHome)) {
    if (entry === "runtime") {
      const runtimeStats = await fs.lstat(path.join(appServerHome, entry));
      if (!runtimeStats.isDirectory() || runtimeStats.isSymbolicLink()) {
        throw new DevSessionError(
          "Beta App Server runtime must be a regular directory",
          5,
          { path: path.join(appServerHome, entry) },
        );
      }
      continue;
    }
    await fs.rm(path.join(appServerHome, entry), {
      recursive: true,
      force: true,
    });
  }
  for (const temporaryPath of [
    path.join(targets.instanceRoot, "build"),
    path.join(targets.instanceRoot, "runtime-artifacts"),
    path.join(targets.instanceRoot, "control"),
    path.join(targets.instanceRoot, "pending.json"),
    path.join(targets.instanceRoot, "diagnostics", "pending.json"),
    path.join(targets.instanceRoot, "update.lock"),
  ]) {
    await fs.rm(temporaryPath, { recursive: true, force: true });
  }
  return { userDataRecreated: true, appServerMutableStateCleared: true };
}

export async function recordBetaSlotRelease({
  slotId,
  revision,
  cleanupSummary,
  diskSummary = null,
  homeDir = os.homedir(),
}) {
  const paths = resolveBetaPoolPaths(homeDir);
  await atomicWriteJson(
    path.join(paths.metadataDir, `${assertBetaSlotId(slotId)}.json`),
    {
      schemaVersion: 1,
      slotId,
      lastRevision: revision,
      lastReleasedAt: new Date().toISOString(),
      lastCleanupSummary: cleanupSummary,
      lastDiskSummary: diskSummary,
    },
    paths.poolRoot,
  );
}

async function readLeaseManifest(lease) {
  try {
    const handle = await fs.open(
      lease.ownerManifestPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        return null;
      }
      return JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function recordedSlotProcessesAreAbsent(slotId, homeDir) {
  const targets = resolveBetaUpdateTargets(homeDir, slotId);
  const [desktop, backend, appServer, references] = await Promise.all([
    inspectRecordedProcessState(
      path.join(targets.userData, "beta-desktop-status.json"),
      ["app", "pid"],
    ),
    inspectRecordedProcessState(
      path.join(targets.userData, "browser-profile", "backend.lock.json"),
      ["pid"],
    ),
    inspectRecordedProcessState(
      path.join(targets.appServerHome, "app-server.lock.json"),
      ["pid"],
    ),
    inspectProcessReferences([
      targets.appPath,
      targets.instanceRoot,
      targets.userData,
      targets.appServerHome,
    ]),
  ]);
  const evidence = [desktop, backend, appServer, references];
  return evidence.every((entry) => entry.trusted && !entry.active);
}

async function stopRecordedDedicatedServices(manifest, lease) {
  const dedicatedServices = [
    manifest.services?.electron,
    manifest.services?.backend,
    manifest.services?.appServer,
  ].filter((service) => service?.ownership === "dedicated");
  for (const service of dedicatedServices) {
    if (
      isPidLive(service.process?.pid) &&
      !processIdentityMatches(service.process)
    ) {
      throw new DevSessionError(
        "Beta janitor found a reused or identity-drifted PID",
        5,
        { slotId: lease.slotId, pid: service.process.pid },
      );
    }
  }
  const sourceRoot = manifest.source?.root;
  if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) {
    throw new DevSessionError(
      "Beta janitor manifest source root is invalid",
      5,
      {
        slotId: lease.slotId,
      },
    );
  }
  const controlScript = path.join(sourceRoot, "scripts", "runweave-beta.mjs");
  if (await fs.lstat(controlScript).catch(() => null)) {
    await execFileAsync(
      process.execPath,
      [
        controlScript,
        "stop",
        "--instance",
        lease.slotId,
        "--dev-session",
        lease.ownerSessionId,
      ],
      { cwd: sourceRoot, encoding: "utf8", timeout: 60_000 },
    );
  }
  for (const service of dedicatedServices) {
    if (isPidLive(service.process?.pid)) {
      await stopOwnedProcess(service.process);
    }
  }
}

export async function runBetaPoolJanitor({
  homeDir = os.homedir(),
  applicationsDir = "/Applications",
} = {}) {
  const paths = resolveBetaPoolPaths(homeDir);
  const summary = {
    scannedAt: new Date().toISOString(),
    recovered: [],
    active: [],
    broken: [],
  };
  for (const slotId of BETA_SLOT_IDS) {
    const recoveryClaim = await acquireBetaSlotRecoveryClaim(slotId, paths);
    if (!recoveryClaim) {
      summary.active.push({
        slotId,
        ownerSessionId: null,
        state: "recovering",
      });
      continue;
    }
    try {
      const inspected = await inspectSlot(slotId, paths);
      if (inspected.state === "idle") {
        continue;
      }
      if (inspected.state === "broken") {
        summary.broken.push({ slotId, reason: inspected.reason });
        continue;
      }
      const verified = await assertBetaSlotLease({
        slotId,
        ownerSessionId: inspected.ownerSessionId,
        leaseNonce: (
          await readRegularJson(
            path.join(paths.leasesDir, `${slotId}.lock`),
            paths.poolRoot,
          )
        ).value.leaseNonce,
        homeDir,
      });
      const lease = verified.lease;
      const manifest = await readLeaseManifest(lease);
      if (!manifest) {
        const orphanAgeMs = Date.now() - Date.parse(lease.acquiredAt);
        if (
          isPidLive(lease.allocatorPid) ||
          orphanAgeMs <= 10 * 60_000 ||
          !(await recordedSlotProcessesAreAbsent(slotId, homeDir))
        ) {
          summary.broken.push({
            slotId,
            reason: "lease manifest is missing and orphan identity is not safe",
          });
          continue;
        }
      } else {
        const betaSlot = manifest.targetEnvironment?.betaSlot;
        if (
          manifest.devSessionId !== lease.ownerSessionId ||
          betaSlot?.assignedSlotId !== slotId ||
          betaSlot?.leaseNonce !== lease.leaseNonce
        ) {
          summary.broken.push({
            slotId,
            reason: "lease and manifest owner identity do not match",
          });
          continue;
        }
        if (
          ["ready", "stopping"].includes(manifest.state) ||
          isPidLive(lease.allocatorPid)
        ) {
          summary.active.push({
            slotId,
            ownerSessionId: lease.ownerSessionId,
            state: manifest.state,
          });
          continue;
        }
        if (
          !["planned", "starting", "failed", "stale"].includes(manifest.state)
        ) {
          summary.broken.push({
            slotId,
            reason: `manifest state is not recoverable: ${String(manifest.state)}`,
          });
          continue;
        }
        try {
          await stopRecordedDedicatedServices(manifest, lease);
        } catch (error) {
          summary.broken.push({
            slotId,
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }
      try {
        const reset = await resetBetaSlotMutableState({ slotId, homeDir });
        const retention = await applyBetaSlotRetention({
          slotId,
          homeDir,
          applicationsDir,
        });
        await recordBetaSlotRelease({
          slotId,
          revision: lease.ownerRevision,
          cleanupSummary: { ...reset, retention, recoveredByJanitor: true },
          homeDir,
        });
        if (manifest) {
          await atomicWriteJson(
            lease.ownerManifestPath,
            {
              ...manifest,
              state: "stopped",
              updatedAt: new Date().toISOString(),
              failure: null,
            },
            path.dirname(lease.ownerManifestPath),
          );
        }
        await releaseBetaSlotLease({
          slotId,
          ownerSessionId: lease.ownerSessionId,
          leaseNonce: lease.leaseNonce,
          homeDir,
        });
        summary.recovered.push({
          slotId,
          ownerSessionId: lease.ownerSessionId,
        });
      } catch (error) {
        summary.broken.push({
          slotId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      await releaseBetaSlotRecoveryClaim(recoveryClaim, paths);
    }
  }
  return summary;
}
