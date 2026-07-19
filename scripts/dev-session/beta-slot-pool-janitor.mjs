import os from "node:os";

import { runBetaPoolRecoveryPass } from "./beta-slot-pool-recovery-pass.mjs";

export async function runBetaPoolJanitor({
  homeDir = os.homedir(),
  applicationsDir = "/Applications",
  strategy = "startup_hygiene",
  requestedSlotId = null,
  initiatingSessionId = null,
  neededCapacity = 1,
  secondCheckDelayMs = 5_000,
} = {}) {
  const recovery = await runBetaPoolRecoveryPass({
    strategy,
    requestedSlotId,
    initiatingSessionId,
    neededCapacity,
    secondCheckDelayMs,
    homeDir,
    applicationsDir,
  });
  const attempted = new Set(
    [
      ...recovery.recovered,
      ...recovery.preserved,
      ...recovery.blocked,
      ...recovery.failed,
    ].map((receipt) => receipt.slotId),
  );
  const observedActive = recovery.projection.slots
    .filter(
      (slot) =>
        !attempted.has(slot.slotId) &&
        ["healthy", "partial", "degraded-shared"].includes(slot.derivedState),
    )
    .map((slot) => ({
      slotId: slot.slotId,
      ownerSessionId: slot.lease.owner?.sessionId ?? null,
      state: slot.derivedState,
    }));
  const observedBroken = recovery.projection.slots
    .filter(
      (slot) =>
        !attempted.has(slot.slotId) &&
        ["stale-manual", "broken"].includes(slot.derivedState),
    )
    .map((slot) => ({
      slotId: slot.slotId,
      reason: slot.reasons.includes("manifest-absent")
        ? "lease manifest is missing and orphan identity is not safe"
        : (slot.recovery.blockedBy[0] ?? slot.reasons[0] ?? "recovery blocked"),
    }));
  return {
    scannedAt: recovery.projection.observedAt,
    recovered: recovery.recovered.map((receipt) => ({
      slotId: receipt.slotId,
      ownerSessionId: receipt.ownerSessionId,
    })),
    active: [
      ...recovery.preserved.map((receipt) => ({
        slotId: receipt.slotId,
        ownerSessionId: receipt.ownerSessionId,
        state: "preserved",
        receipt,
      })),
      ...observedActive,
    ],
    broken: [
      ...[...recovery.blocked, ...recovery.failed].map((receipt) => ({
        slotId: receipt.slotId,
        reason:
          receipt.failureReason ?? receipt.blockedBy[0] ?? "recovery blocked",
        receipt,
      })),
      ...observedBroken,
    ],
    poolRecovery: recovery,
  };
}
