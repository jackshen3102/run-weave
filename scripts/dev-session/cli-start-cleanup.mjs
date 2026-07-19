import { DevSessionError } from "./contracts.mjs";
import { withSessionLock, writeManifest } from "./registry.mjs";
import { stopSessionServices } from "./services.mjs";
import {
  acquireBetaSlotRecoveryClaim,
  createBetaPoolRecoveryReceipt,
  finalizeBetaSlotRelease,
  releaseBetaSlotRecoveryClaim,
  resolveBetaPoolPaths,
} from "./beta-slot-pool.mjs";
import {
  readOptionalManifest,
  retainsBetaSlotLease,
  updateManifest,
} from "./cli-manifest.mjs";

export async function cleanupFailedStart({
  error,
  sessionId,
  manifestCreated,
  slotLease,
  diskSummary,
  startedServices,
}) {
  if (!manifestCreated) {
    return;
  }
  const poolPaths = slotLease ? resolveBetaPoolPaths() : null;
  const recoveryClaim = slotLease
    ? await acquireBetaSlotRecoveryClaim(slotLease.lease.slotId, poolPaths)
    : null;
  if (slotLease && !recoveryClaim) {
    return;
  }
  try {
    await withSessionLock(sessionId, async () => {
      const existing = await readOptionalManifest(sessionId);
      if (
        !existing ||
        existing.state === "ready" ||
        (slotLease && !retainsBetaSlotLease(existing))
      ) {
        return;
      }
      let finalizedReceipt = null;
      let resetFailure =
        error instanceof DevSessionError && error.details?.resetUnsafe
          ? new Error("identity-safe start cleanup did not complete")
          : null;
      if (startedServices && !resetFailure) {
        try {
          await stopSessionServices(startedServices);
        } catch (cleanupError) {
          resetFailure = cleanupError;
        }
      }
      if (slotLease && !resetFailure) {
        try {
          const cleanupManifest = updateManifest(existing, {
            ...(startedServices ? { services: startedServices } : {}),
          });
          const finalized = await finalizeBetaSlotRelease({
            lease: slotLease.lease,
            manifest: cleanupManifest,
            receipt: createBetaPoolRecoveryReceipt({
              trigger: "start_failure",
              initiatingSessionId: sessionId,
              slotId: slotLease.lease.slotId,
              ownerSessionId: sessionId,
              leaseNonce: slotLease.lease.leaseNonce,
              previousManifestState: cleanupManifest.state,
              previousDerivedState: "start-failed",
            }),
            diskSummary,
            completedManifestState: "failed",
            claimAlreadyHeld: true,
          });
          finalizedReceipt = finalized.receipt;
        } catch (cleanupError) {
          resetFailure = cleanupError;
          finalizedReceipt =
            cleanupError instanceof DevSessionError
              ? (cleanupError.details?.receipt ?? null)
              : null;
        }
      }
      const finalizationPending =
        resetFailure instanceof DevSessionError &&
        resetFailure.details?.leaseReleased;
      const failedManifest = updateManifest(existing, {
        state: finalizationPending
          ? "stopping"
          : resetFailure
            ? "stale"
            : "failed",
        ...(startedServices ? { services: startedServices } : {}),
        ...(finalizedReceipt ? { poolRecovery: finalizedReceipt } : {}),
        failure: {
          message: error instanceof Error ? error.message : String(error),
          exitCode: error instanceof DevSessionError ? error.exitCode : 1,
          ...(resetFailure && !finalizationPending
            ? {
                resetFailure:
                  resetFailure instanceof Error
                    ? resetFailure.message
                    : String(resetFailure),
                leaseRetained: true,
              }
            : { leaseRetained: false }),
        },
      });
      await writeManifest(failedManifest);
    });
  } finally {
    if (recoveryClaim) {
      await releaseBetaSlotRecoveryClaim(recoveryClaim, poolPaths);
    }
  }
}
