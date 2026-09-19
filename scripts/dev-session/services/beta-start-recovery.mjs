import os from "node:os";
import path from "node:path";
import { DevSessionError } from "../contracts.mjs";
import {
  assertBetaSlotLease,
  betaSlotProcessesAreAbsent,
} from "../beta-pool/index.mjs";
import {
  inspectBetaDesktopProcessOwnership,
  isPidLive,
  readJson,
  resolveBetaPaths,
} from "../../beta/state.mjs";
import { quitBeta, withBetaLock } from "../../beta/operations.mjs";

// Older failed starts have only planned services. Readiness is not proof of
// ownership: recovery uses the lease and independently recorded desktop identity.
export async function cleanupIncompleteBetaStart(
  manifest,
  { homeDir = os.homedir() } = {},
) {
  const slot = manifest.targetEnvironment?.betaSlot;
  if (
    manifest.profile !== "beta" ||
    !slot?.assignedSlotId ||
    manifest.services.electron?.process?.pid ||
    manifest.services.beta?.process?.pid
  ) {
    return false;
  }
  const slotId = slot.assignedSlotId;
  if (
    manifest.targetEnvironment.instanceId !== slotId ||
    !["electron", "beta"].every((name) => {
      const service = manifest.services[name];
      return (
        service?.ownership === "dedicated" &&
        service.slotId === slotId &&
        service.leaseNonce === slot.leaseNonce
      );
    })
  ) {
    throw new DevSessionError("incomplete Beta start ownership drifted", 5, {
      resetUnsafe: true,
    });
  }
  const { lease } = await assertBetaSlotLease({
    slotId,
    ownerSessionId: manifest.devSessionId,
    leaseNonce: slot.leaseNonce,
    homeDir,
  });
  if (lease.ownerSourceRoot !== manifest.source.root) {
    throw new DevSessionError("incomplete Beta source ownership drifted", 5, {
      resetUnsafe: true,
    });
  }
  const paths = resolveBetaPaths(
    manifest.source.root,
    homeDir,
    slotId,
    manifest.devSessionId,
  );
  return await withBetaLock(paths, async () => {
    if (await betaSlotProcessesAreAbsent(slotId, homeDir)) return true;
    const ownership = await inspectBetaDesktopProcessOwnership(paths);
    if (!ownership.ok) {
      throw new DevSessionError(
        "incomplete Beta desktop ownership cannot be proven",
        5,
        { resetUnsafe: true },
      );
    }
    const backendLock = await readJson(
      path.join(paths.profileDir, "backend.lock.json"),
    );
    if (
      backendLock &&
      isPidLive(backendLock.pid) &&
      backendLock.devSessionId !== manifest.devSessionId
    ) {
      throw new DevSessionError(
        "incomplete Beta Backend ownership drifted",
        5,
        { resetUnsafe: true },
      );
    }
    // Do not adopt arbitrary remaining Backend/App Server processes. The desktop
    // owns its children; any residual must pass the whole-slot absence barrier.
    await quitBeta(paths);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await betaSlotProcessesAreAbsent(slotId, homeDir)) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new DevSessionError(
      "failed-start Beta processes remain; preserving slot and lease",
      5,
      { resetUnsafe: true },
    );
  });
}
