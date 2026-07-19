import { DevSessionError } from "./contracts.mjs";
import { readManifest } from "./registry.mjs";

export function updateManifest(manifest, fields) {
  return {
    ...manifest,
    ...fields,
    updatedAt: new Date().toISOString(),
  };
}

export function retainsBetaSlotLease(manifest) {
  return Boolean(
    manifest.profile === "beta" &&
    manifest.targetEnvironment.betaSlot?.assignedSlotId &&
    manifest.state !== "stopped" &&
    !(manifest.state === "failed" && manifest.failure?.leaseRetained === false),
  );
}

export async function readOptionalManifest(sessionId) {
  try {
    return await readManifest(sessionId);
  } catch (error) {
    if (error instanceof DevSessionError && error.exitCode === 3) {
      return null;
    }
    throw error;
  }
}
