import os from "node:os";

import { inspectBetaSlotCapacity } from "./beta-slot-pool-core.mjs";
import { inspectBetaSlotRetentionSafety } from "./beta-slot-pool-retention.mjs";

export async function inspectAllocatableBetaSlotCapacity({
  homeDir = os.homedir(),
  applicationsDir = "/Applications",
} = {}) {
  const snapshot = await inspectBetaSlotCapacity({ homeDir });
  const slots = await Promise.all(
    snapshot.slots.map(async (slot) => {
      if (slot.state !== "idle") {
        return slot;
      }
      const retention = await inspectBetaSlotRetentionSafety({
        slotId: slot.slotId,
        homeDir,
        applicationsDir,
      });
      return retention.healthy
        ? slot
        : {
            ...slot,
            state: "broken",
            broken: true,
            reason: retention.reason,
            retention,
          };
    }),
  );
  return {
    ...snapshot,
    idle: slots.filter((slot) => slot.state === "idle").length,
    occupied: slots.filter((slot) => slot.state === "occupied").length,
    broken: slots.filter((slot) => slot.state === "broken").length,
    slots,
  };
}
