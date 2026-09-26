import path from "node:path";

import { assertBetaSlotLease } from "../dev-session/beta-pool/index.mjs";
import { readManifest } from "../dev-session/registry.mjs";

export async function assertManagedBetaLaunch({
  command,
  instanceId,
  devSessionId,
  sourceRoot,
  homeDir,
}) {
  if (!["update", "open", "rollback"].includes(command)) {
    return;
  }
  if (!devSessionId) {
    throw new Error(
      "standalone Beta launch and rollback are retired; use pnpm dev:session to manage a test instance",
    );
  }
  let manifest;
  try {
    manifest = await readManifest(devSessionId);
  } catch {
    throw new Error(
      "Beta mutation requires an active, registered Dev Session; use pnpm dev:session",
    );
  }
  const slot = manifest.targetEnvironment?.betaSlot;
  if (
    !["starting", "ready"].includes(manifest.state) ||
    manifest.profile !== "beta" ||
    manifest.targetEnvironment?.kind !== "beta" ||
    manifest.targetEnvironment.instanceId !== instanceId ||
    slot?.assignedSlotId !== instanceId ||
    manifest.source?.root !== path.resolve(sourceRoot) ||
    !slot.leaseNonce
  ) {
    throw new Error("Beta mutation does not belong to this Dev Session");
  }
  await assertBetaSlotLease({
    slotId: instanceId,
    ownerSessionId: devSessionId,
    leaseNonce: slot.leaseNonce,
    homeDir,
  });
}
