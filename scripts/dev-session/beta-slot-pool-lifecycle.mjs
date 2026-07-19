import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { DevSessionError } from "./contracts.mjs";
import {
  acquireBetaSlotRecoveryClaim,
  assertBetaSlotLease,
  atomicWriteJson,
  releaseBetaSlotLease,
  releaseBetaSlotRecoveryClaim,
  resolveBetaPoolPaths,
} from "./beta-slot-pool-core.mjs";
import { betaSlotProcessesAreAbsent } from "./beta-slot-pool-process-inspection.mjs";
import {
  applyBetaSlotRetention,
  recordBetaSlotRelease,
  recordBetaSlotRecoveryAttempt,
  resetBetaSlotMutableState,
} from "./beta-slot-pool-storage.mjs";

const RELEASE_FAILURE_CHECKPOINTS = new Set([
  "after_reset",
  "after_metadata",
  "before_release",
  "after_release",
]);

function injectReleaseFailure(checkpoint, requestedCheckpoint) {
  if (!requestedCheckpoint) {
    return;
  }
  if (!RELEASE_FAILURE_CHECKPOINTS.has(requestedCheckpoint)) {
    throw new DevSessionError(
      "RUNWEAVE_BETA_RELEASE_FAILPOINT is not a supported checkpoint",
      2,
      {
        value: requestedCheckpoint,
        allowed: Array.from(RELEASE_FAILURE_CHECKPOINTS),
      },
    );
  }
  if (requestedCheckpoint === checkpoint) {
    throw new DevSessionError(
      `injected Beta release failure at ${checkpoint}`,
      5,
      {
        code: "beta_release_failure_injected",
        checkpoint,
      },
    );
  }
}

export function createBetaPoolRecoveryReceipt({
  trigger,
  initiatingSessionId = null,
  slotId,
  ownerSessionId = null,
  leaseNonce = null,
  previousManifestState = null,
  previousDerivedState = null,
  result = "preserved",
  checks = {},
  stoppedServices = [],
  blockedBy = [],
  releasedLease = false,
  quarantinedLeasePath = null,
  failureReason = null,
  attemptId = randomUUID(),
  attemptedAt = new Date().toISOString(),
  completedAt = null,
  phase = null,
}) {
  return {
    schemaVersion: 1,
    attemptId,
    attemptedAt,
    completedAt,
    trigger,
    initiatingSessionId,
    slotId,
    ownerSessionId,
    leaseNonce,
    previousManifestState,
    previousDerivedState,
    result,
    phase,
    checks,
    stoppedServices,
    blockedBy,
    releasedLease,
    quarantinedLeasePath,
    failureReason,
  };
}

async function writeOwnerManifest(lease, manifest, receipt, state, failure) {
  if (!manifest) {
    return;
  }
  await atomicWriteJson(
    lease.ownerManifestPath,
    {
      ...manifest,
      state,
      updatedAt: new Date().toISOString(),
      poolRecovery: receipt,
      failure,
    },
    path.dirname(lease.ownerManifestPath),
  );
}

async function finalizeBetaSlotReleaseClaimed({
  lease,
  manifest = null,
  receipt,
  homeDir = os.homedir(),
  applicationsDir = "/Applications",
  diskSummary = null,
  completedManifestState = "stopped",
  failureCheckpoint = process.env.RUNWEAVE_BETA_RELEASE_FAILPOINT?.trim() ||
    null,
}) {
  injectReleaseFailure("validation", failureCheckpoint);
  await assertBetaSlotLease({
    slotId: lease.slotId,
    ownerSessionId: lease.ownerSessionId,
    leaseNonce: lease.leaseNonce,
    homeDir,
  });
  if (!(await betaSlotProcessesAreAbsent(lease.slotId, homeDir))) {
    throw new DevSessionError(
      "Beta slot processes remain; refusing to reset or release the slot",
      5,
      { slotId: lease.slotId, resetUnsafe: true },
    );
  }
  let leaseReleased = false;
  try {
    const reset = await resetBetaSlotMutableState({
      slotId: lease.slotId,
      homeDir,
    });
    injectReleaseFailure("after_reset", failureCheckpoint);
    let retention = null;
    let retentionError = null;
    try {
      retention = await applyBetaSlotRetention({
        slotId: lease.slotId,
        homeDir,
        applicationsDir,
      });
    } catch (error) {
      retentionError = error instanceof Error ? error.message : String(error);
    }
    const pendingReceipt = {
      ...receipt,
      result: "recovered",
      phase: "release_pending",
      checks: {
        ...receipt.checks,
        slotProcessesAbsent: true,
        ...(retentionError ? { retentionFailed: retentionError } : {}),
      },
      failureReason: retentionError || null,
    };
    const cleanupSummary = {
      ...reset,
      retention: retention || { retentionFailed: retentionError },
    };
    await recordBetaSlotRelease({
      slotId: lease.slotId,
      revision: lease.ownerRevision,
      cleanupSummary,
      diskSummary,
      recoveryAttempt: pendingReceipt,
      homeDir,
    });
    injectReleaseFailure("after_metadata", failureCheckpoint);
    await writeOwnerManifest(lease, manifest, pendingReceipt, "stopping", null);
    injectReleaseFailure("before_release", failureCheckpoint);
    await releaseBetaSlotLease({
      slotId: lease.slotId,
      ownerSessionId: lease.ownerSessionId,
      leaseNonce: lease.leaseNonce,
      homeDir,
    });
    leaseReleased = true;
    injectReleaseFailure("after_release", failureCheckpoint);
    const completedReceipt = {
      ...pendingReceipt,
      completedAt: new Date().toISOString(),
      phase: "completed",
      releasedLease: true,
    };
    await writeOwnerManifest(
      lease,
      manifest,
      completedReceipt,
      completedManifestState,
      completedManifestState === "failed"
        ? {
            message: "Beta Session start failed after safe slot cleanup",
            exitCode: 1,
            leaseRetained: false,
          }
        : null,
    );
    await recordBetaSlotRecoveryAttempt({
      slotId: lease.slotId,
      attempt: completedReceipt,
      homeDir,
    });
    return { receipt: completedReceipt, cleanupSummary };
  } catch (error) {
    if (leaseReleased) {
      const releasedPendingReceipt = {
        ...receipt,
        result: "recovered",
        phase: "release_pending",
        releasedLease: true,
        failureReason: error instanceof Error ? error.message : String(error),
      };
      await recordBetaSlotRecoveryAttempt({
        slotId: lease.slotId,
        attempt: releasedPendingReceipt,
        homeDir,
      }).catch(() => undefined);
      await writeOwnerManifest(
        lease,
        manifest,
        releasedPendingReceipt,
        "stopping",
        null,
      ).catch(() => undefined);
      throw new DevSessionError(
        "Beta slot lease released; manifest finalization remains pending",
        5,
        {
          leaseReleased: true,
          receipt: releasedPendingReceipt,
        },
      );
    }
    const failedReceipt = {
      ...receipt,
      completedAt: new Date().toISOString(),
      result: "failed",
      phase: "failed",
      releasedLease: false,
      failureReason: error instanceof Error ? error.message : String(error),
    };
    await recordBetaSlotRecoveryAttempt({
      slotId: lease.slotId,
      attempt: failedReceipt,
      homeDir,
    }).catch(() => undefined);
    await writeOwnerManifest(lease, manifest, failedReceipt, "stale", {
      message: failedReceipt.failureReason,
      exitCode: error instanceof DevSessionError ? error.exitCode : 1,
      leaseRetained: true,
    }).catch(() => undefined);
    throw new DevSessionError("Beta pool recovery failed; lease retained", 5, {
      code: "beta_pool_recovery_failed_lease_retained",
      receipt: failedReceipt,
    });
  }
}

export async function finalizeBetaSlotRelease(options) {
  if (options.claimAlreadyHeld) {
    return await finalizeBetaSlotReleaseClaimed(options);
  }
  const homeDir = options.homeDir ?? os.homedir();
  const paths = resolveBetaPoolPaths(homeDir);
  const claim = await acquireBetaSlotRecoveryClaim(options.lease.slotId, paths);
  if (!claim) {
    throw new DevSessionError("Beta slot recovery claim is busy", 5, {
      slotId: options.lease.slotId,
      code: "beta_pool_recovery_claim_busy",
    });
  }
  try {
    return await finalizeBetaSlotReleaseClaimed(options);
  } finally {
    await releaseBetaSlotRecoveryClaim(claim, paths);
  }
}
