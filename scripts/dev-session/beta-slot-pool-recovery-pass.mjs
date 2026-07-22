import os from "node:os";

import {
  BETA_SLOT_CAPACITY,
  assertBetaSlotId,
} from "./beta-slot-pool-core.mjs";
import { createBetaPoolRecoveryReceipt } from "./beta-slot-pool-lifecycle.mjs";
import { inspectBetaPool } from "./beta-slot-pool-projection.mjs";
import { recoverBetaPoolSlot } from "./beta-slot-pool-recovery.mjs";

const RECOVERY_CANDIDATE_COST = new Map([
  ["stale-reclaimable", 0],
  ["broken", 1],
  ["partial", 2],
]);
const RECOVERY_CANDIDATE_ORDERING_REASON =
  "recovery-cost-ascending, acquiredAt-ascending, slotId-ascending";

function recoveryCandidateCost(slot) {
  return RECOVERY_CANDIDATE_COST.get(slot.derivedState) ?? 99;
}

function sortRecoveryCandidates(slots) {
  return [...slots].sort((left, right) => {
    const leftCost = recoveryCandidateCost(left);
    const rightCost = recoveryCandidateCost(right);
    const leftAcquired = Date.parse(left.lease.acquiredAt ?? "") || Infinity;
    const rightAcquired = Date.parse(right.lease.acquiredAt ?? "") || Infinity;
    return (
      leftCost - rightCost ||
      leftAcquired - rightAcquired ||
      left.slotId.localeCompare(right.slotId)
    );
  });
}

function createUnselectedCandidateReceipt(candidate, initiatingSessionId) {
  return {
    ...createBetaPoolRecoveryReceipt({
      trigger: "capacity_pressure",
      initiatingSessionId,
      slotId: candidate.slotId,
      ownerSessionId: candidate.lease.owner?.sessionId ?? null,
      leaseNonce: candidate.lease.owner?.leaseNonce ?? null,
      previousManifestState: candidate.manifest.state,
      previousDerivedState: candidate.derivedState,
      result: "preserved",
      checks: candidate.recovery.checks,
      blockedBy: ["capacity-satisfied-by-higher-priority-candidate"],
      completedAt: new Date().toISOString(),
    }),
    selectionReason: "not-selected-capacity-already-satisfied",
  };
}

export async function runBetaPoolRecoveryPass({
  strategy = "startup_hygiene",
  requestedSlotId = null,
  initiatingSessionId = null,
  neededCapacity = 1,
  secondCheckDelayMs = 5_000,
  homeDir = os.homedir(),
  applicationsDir = "/Applications",
} = {}) {
  if (requestedSlotId) {
    assertBetaSlotId(requestedSlotId);
  }
  const projection = await inspectBetaPool({ homeDir, applicationsDir });
  let candidates = projection.slots.filter((slot) =>
    requestedSlotId ? slot.slotId === requestedSlotId : true,
  );
  if (strategy === "startup_hygiene") {
    candidates = candidates.filter(
      (slot) =>
        slot.recovery.eligible && ["hygiene"].includes(slot.recovery.mode),
    );
  } else {
    candidates = candidates.filter(
      (slot) =>
        slot.recovery.eligible &&
        ["hygiene", "capacity_pressure"].includes(slot.recovery.mode),
    );
    candidates = sortRecoveryCandidates(candidates);
  }
  const orderedCandidates = sortRecoveryCandidates(candidates);
  const receipts = [];
  const candidateOrder = [];
  for (const [index, candidate] of orderedCandidates.entries()) {
    const recoveredCapacity = receipts.filter(
      (entry) => entry.result === "recovered",
    ).length;
    if (strategy !== "startup_hygiene" && recoveredCapacity >= neededCapacity) {
      const receipt = createUnselectedCandidateReceipt(
        candidate,
        initiatingSessionId,
      );
      receipts.push(receipt);
      candidateOrder.push({
        rank: index + 1,
        slotId: candidate.slotId,
        derivedState: candidate.derivedState,
        recoveryCost: recoveryCandidateCost(candidate),
        acquiredAt: candidate.lease.acquiredAt,
        result: receipt.result,
        selectionReason: receipt.selectionReason,
      });
      continue;
    }
    const receipt = await recoverBetaPoolSlot({
      slotId: candidate.slotId,
      trigger:
        strategy === "startup_hygiene"
          ? "startup_hygiene"
          : "capacity_pressure",
      initiatingSessionId,
      strategy:
        strategy === "startup_hygiene" ? "hygiene" : "capacity_pressure",
      secondCheckDelayMs,
      homeDir,
      applicationsDir,
    });
    receipts.push(receipt);
    candidateOrder.push({
      rank: index + 1,
      slotId: candidate.slotId,
      derivedState: candidate.derivedState,
      recoveryCost: recoveryCandidateCost(candidate),
      acquiredAt: candidate.lease.acquiredAt,
      result: receipt.result,
      selectionReason: "attempted-in-deterministic-candidate-order",
    });
  }
  return {
    trigger: strategy,
    recovered: receipts.filter((receipt) => receipt.result === "recovered"),
    preserved: receipts.filter((receipt) => receipt.result === "preserved"),
    blocked: receipts.filter((receipt) => receipt.result === "blocked"),
    failed: receipts.filter((receipt) => receipt.result === "failed"),
    candidateOrder,
    orderingReason: RECOVERY_CANDIDATE_ORDERING_REASON,
    projection,
    boundedAttempts: BETA_SLOT_CAPACITY + 1,
  };
}
