import { DevSessionError } from "./contracts.mjs";
import {
  BETA_SLOT_CAPACITY,
  acquireBetaSlotLease,
  releaseBetaSlotLease,
} from "./beta-slot-pool-core.mjs";
import { inspectBetaSlotRetentionSafety } from "./beta-slot-pool-retention.mjs";
import { runBetaPoolRecoveryPass } from "./beta-slot-pool-recovery-pass.mjs";

export async function acquireStartBetaSlotLease({
  requestedSlotId,
  sessionId,
  sourceRoot,
  revision,
  ownerManifestPath,
  poolRecovery,
  mergePoolRecovery,
}) {
  let slotLease = null;
  const storageBlockedSlotIds = new Set();
  for (let attempt = 0; attempt <= BETA_SLOT_CAPACITY; attempt += 1) {
    try {
      slotLease = await acquireBetaSlotLease({
        requestedSlotId,
        excludedSlotIds: [...storageBlockedSlotIds],
        ownerSessionId: sessionId,
        ownerSourceRoot: sourceRoot,
        ownerRevision: revision,
        ownerManifestPath,
      });
    } catch (error) {
      if (
        error instanceof DevSessionError &&
        [
          "beta_pool_legacy_drain_required",
          "beta_pool_storage_migration_busy",
          "beta_pool_storage_migration_blocked",
          "beta_pool_storage_conflict",
        ].includes(error.details?.code)
      ) {
        throw error;
      }
      if (requestedSlotId) {
        throw new DevSessionError(
          `requested Beta slot is occupied: ${requestedSlotId}`,
          5,
          {
            code: "beta_pool_requested_slot_occupied",
            requestedSlotId,
            slots: error.details?.slots ?? [],
          },
        );
      }
      if (
        !(error instanceof DevSessionError) ||
        attempt === BETA_SLOT_CAPACITY
      ) {
        throw error;
      }
      const pressure = await runBetaPoolRecoveryPass({
        strategy: "capacity_pressure",
        requestedSlotId,
        initiatingSessionId: sessionId,
      });
      mergePoolRecovery(pressure);
      if (pressure.recovered.length === 0) {
        throw new DevSessionError(error.message, error.exitCode, {
          ...error.details,
          code: requestedSlotId
            ? "beta_pool_requested_slot_occupied"
            : "beta_pool_capacity_exhausted",
          poolRecovery,
        });
      }
    }
    if (!slotLease) {
      continue;
    }
    let retentionSafety;
    try {
      retentionSafety = await inspectBetaSlotRetentionSafety({
        slotId: slotLease.lease.slotId,
      });
    } catch (error) {
      await releaseBetaSlotLease(slotLease);
      throw error;
    }
    if (retentionSafety.healthy) {
      return slotLease;
    }
    const blockedSlotId = slotLease.lease.slotId;
    await releaseBetaSlotLease(slotLease);
    slotLease = null;
    const blocked = {
      trigger: "startup_storage_preflight",
      result: "blocked",
      slotId: blockedSlotId,
      failureReason: retentionSafety.reason,
      details: retentionSafety.details,
    };
    poolRecovery.blocked.push(blocked);
    if (requestedSlotId) {
      throw new DevSessionError(retentionSafety.reason, 5, {
        code: "beta_pool_requested_slot_storage_broken",
        requestedSlotId,
        retention: retentionSafety,
        poolRecovery,
      });
    }
    storageBlockedSlotIds.add(blockedSlotId);
    if (storageBlockedSlotIds.size === BETA_SLOT_CAPACITY) {
      throw new DevSessionError(
        "all five Beta slots have invalid retained state",
        5,
        {
          code: "beta_pool_retention_state_exhausted",
          blockedSlots: poolRecovery.blocked.filter(
            (entry) => entry.trigger === "startup_storage_preflight",
          ),
          poolRecovery,
        },
      );
    }
  }
  throw new DevSessionError(
    "Beta pool capacity was won by a concurrent allocator",
    5,
    {
      code: "beta_pool_capacity_won_by_concurrent_allocator",
      poolRecovery,
    },
  );
}
