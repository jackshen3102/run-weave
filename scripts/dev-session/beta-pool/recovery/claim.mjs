import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { DevSessionError } from "../../contracts.mjs";
import { readProcessSignature } from "../../services/runtime.mjs";
import {
  atomicWriteJson,
  ensureDirectory,
  readRegularJson,
  sameFileIdentity,
} from "../storage/files.mjs";

const RECOVERY_CLAIM_SCHEMA_VERSION = 1;
const RELEASE_GUARD_TIMEOUT_MS = 1_000;

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
    throw new DevSessionError("Beta recovery claim is corrupt", 5, { slotId });
  }
  return value;
}

async function releaseTransitionGuard(guardPath, guardStats, slotId) {
  const named = await fs.lstat(guardPath);
  if (
    !named.isDirectory() ||
    named.isSymbolicLink() ||
    !sameFileIdentity(guardStats, named)
  ) {
    throw new DevSessionError("Beta recovery transition identity drifted", 5, {
      slotId,
    });
  }
  await fs.rmdir(guardPath);
}

// Only claim transitions use this guard. Never wait for outer locks while held.
// An interrupted guard is unavailable, not evidence that its owner is dead.
async function withTransitionGuard(slotId, paths, waitForRelease, callback) {
  await ensureDirectory(paths.recoveryClaimsDir, paths.poolRoot);
  const guardPath = path.join(paths.recoveryClaimsDir, `.${slotId}.transition`);
  const deadline = Date.now() + RELEASE_GUARD_TIMEOUT_MS;
  for (;;) {
    try {
      await fs.mkdir(guardPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (!waitForRelease) return null;
      if (Date.now() >= deadline) {
        throw new DevSessionError("Beta recovery claim transition is busy", 5, {
          slotId,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const guardStats = await fs.lstat(guardPath);
  try {
    return await callback();
  } finally {
    await releaseTransitionGuard(guardPath, guardStats, slotId);
  }
}

async function readClaimGeneration(claimPath, slotId, paths) {
  const claimStats = await fs.lstat(claimPath);
  if (!claimStats.isDirectory() || claimStats.isSymbolicLink()) {
    throw new Error("claim is not a regular directory");
  }
  const { value, stats: ownerStats } = await readRegularJson(
    path.join(claimPath, "owner.json"),
    paths.recoveryClaimsDir,
  );
  const claim = validateRecoveryClaim(value, slotId);
  const entries = await fs.readdir(claimPath);
  const named = await fs.lstat(claimPath);
  if (
    !sameFileIdentity(claimStats, named) ||
    entries.length !== 1 ||
    entries[0] !== "owner.json"
  ) {
    throw new Error("claim directory identity or contents changed");
  }
  return { claim, claimPath, claimStats, ownerStats };
}

function sameClaimGeneration(left, right) {
  return (
    sameFileIdentity(left.claimStats, right.claimStats) &&
    sameFileIdentity(left.ownerStats, right.ownerStats) &&
    JSON.stringify(left.claim) === JSON.stringify(right.claim)
  );
}

function ownerIsProvenAbsent(claim) {
  try {
    process.kill(claim.pid, 0);
    // A live/reused PID or unreadable signature is not proof of absence.
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

export async function acquireBetaSlotRecoveryClaim(slotId, paths) {
  return await withTransitionGuard(slotId, paths, false, async () => {
    const claimPath = path.join(paths.recoveryClaimsDir, `${slotId}.lock`);
    const existing = await fs.lstat(claimPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      const current = await readClaimGeneration(claimPath, slotId, paths).catch(
        () => null,
      );
      if (
        !current ||
        !sameFileIdentity(existing, current.claimStats) ||
        !ownerIsProvenAbsent(current.claim)
      ) {
        return null;
      }
      const rechecked = await readClaimGeneration(
        claimPath,
        slotId,
        paths,
      ).catch(() => null);
      if (
        !rechecked ||
        !sameClaimGeneration(current, rechecked) ||
        !ownerIsProvenAbsent(rechecked.claim)
      ) {
        return null;
      }
      // The guard excludes all cooperating acquire/release renames, not just
      // other stale reapers; a generation recheck alone cannot prevent ABA.
      const stalePath = path.join(
        paths.recoveryClaimsDir,
        `.${slotId}.${randomUUID()}.stale`,
      );
      await fs.rename(claimPath, stalePath);
      const moved = await readClaimGeneration(stalePath, slotId, paths);
      if (!sameClaimGeneration(current, moved)) {
        throw new DevSessionError(
          "Beta recovery stale claim identity drifted",
          5,
          { slotId },
        );
      }
      await fs.rm(stalePath, { recursive: true });
    }

    const claim = {
      schemaVersion: RECOVERY_CLAIM_SCHEMA_VERSION,
      slotId,
      claimNonce: randomUUID(),
      pid: process.pid,
      processSignature: readProcessSignature(process.pid),
      acquiredAt: new Date().toISOString(),
    };
    validateRecoveryClaim(claim, slotId);
    const candidatePath = path.join(
      paths.recoveryClaimsDir,
      `.${slotId}.${claim.claimNonce}.tmp`,
    );
    await fs.mkdir(candidatePath, { mode: 0o700 });
    try {
      await atomicWriteJson(
        path.join(candidatePath, "owner.json"),
        claim,
        candidatePath,
      );
      const candidate = await readClaimGeneration(candidatePath, slotId, paths);
      await fs.rename(candidatePath, claimPath);
      const published = await readClaimGeneration(claimPath, slotId, paths);
      if (!sameClaimGeneration(candidate, published)) {
        throw new DevSessionError(
          "Beta recovery claim publish identity drifted",
          5,
          { slotId },
        );
      }
      return published;
    } finally {
      await fs.rm(candidatePath, { recursive: true, force: true });
    }
  });
}

export async function releaseBetaSlotRecoveryClaim(recoveryClaim, paths) {
  const slotId = recoveryClaim.claim.slotId;
  return await withTransitionGuard(slotId, paths, true, async () => {
    const claimPath = path.join(paths.recoveryClaimsDir, `${slotId}.lock`);
    const current = await readClaimGeneration(claimPath, slotId, paths);
    if (
      recoveryClaim.claimPath !== claimPath ||
      !sameClaimGeneration(recoveryClaim, current) ||
      current.claim.pid !== process.pid ||
      current.claim.processSignature !== readProcessSignature(process.pid)
    ) {
      throw new DevSessionError(
        "Beta recovery claim owner identity drifted",
        5,
        { slotId },
      );
    }
    const releasedPath = path.join(
      paths.recoveryClaimsDir,
      `.${slotId}.${current.claim.claimNonce}.released`,
    );
    await fs.rename(claimPath, releasedPath);
    const moved = await readClaimGeneration(releasedPath, slotId, paths);
    if (!sameClaimGeneration(current, moved)) {
      throw new DevSessionError(
        "Beta recovery released claim identity drifted",
        5,
        { slotId },
      );
    }
    await fs.rm(releasedPath, { recursive: true });
  });
}
