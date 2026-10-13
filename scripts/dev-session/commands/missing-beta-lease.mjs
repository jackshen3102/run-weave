import { DevSessionError } from "../contracts.mjs";
import {
  assertBetaPoolStorageReadyForExistingLease,
  inspectBetaSlotCapacity,
  inspectBetaSlotProcessSafety,
} from "../beta-pool/index.mjs";
import { retainsBetaSlotLease } from "./manifest.mjs";

// Called under the Session lock; mutation also requires the slot recovery claim.
export async function inspectMissingBetaLease(manifest) {
  if (manifest.state !== "stale" || !retainsBetaSlotLease(manifest)) {
    return null;
  }
  await assertBetaPoolStorageReadyForExistingLease();
  const slotId = manifest.targetEnvironment.betaSlot.assignedSlotId;
  const capacity = await inspectBetaSlotCapacity();
  if (capacity.slots.find((slot) => slot.slotId === slotId)?.state !== "idle") {
    return null;
  }
  const safety = await inspectBetaSlotProcessSafety(slotId);
  const blockedServices = [];
  const services = [
    ...Object.entries(manifest.services),
    ...Object.entries(manifest.services.cdp ?? {}),
  ];
  for (const [name, service] of services) {
    if (service?.ownership !== "dedicated") {
      continue;
    }
    for (const pid of new Set([service.pid, service.process?.pid])) {
      if (pid == null) {
        continue;
      }
      if (!Number.isInteger(pid) || pid <= 0) {
        blockedServices.push(name);
        continue;
      }
      try {
        process.kill(pid, 0);
        blockedServices.push(name);
      } catch (error) {
        if (error.code !== "ESRCH") {
          blockedServices.push(name);
        }
      }
    }
  }
  if (!safety.safeToReset || blockedServices.length) {
    throw new DevSessionError(
      "Beta lease is absent but Session release cannot be confirmed",
      5,
      {
        code: "beta_session_missing_lease_cleanup_blocked",
        slotId,
        devSessionId: manifest.devSessionId,
        safety,
        blockedServices,
      },
    );
  }
  return {
    leaseAbsent: true,
    slotProcessesAbsent: true,
    recordedDedicatedProcessesAbsent: true,
    observedAt: new Date().toISOString(),
  };
}
