import { createHash } from "node:crypto";

export function ownershipVersion(generation, identity) {
  return createHash("sha256")
    .update(JSON.stringify([generation, identity]))
    .digest("hex");
}

export function sessionIdentity(manifest) {
  return [
    manifest.devSessionId,
    manifest.source.root,
    manifest.targetEnvironment?.betaSlot?.leaseNonce ?? null,
    Object.entries(manifest.services)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, service]) => [
        name,
        service?.ownership,
        service?.process?.pid,
        service?.process?.processSignature,
      ]),
  ];
}

export function slotIdentity(slot) {
  return [
    slot.slotId,
    slot.lease.owner?.sessionId,
    slot.lease.owner?.sourceRoot,
    slot.lease.owner?.leaseNonce,
    slot.lease.acquiredAt,
    Object.entries(slot.runtime?.ownedComponents ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, service]) => [name, service.pid]),
  ];
}

export function assertExpectedVersion(actual, expected) {
  if (!expected || actual !== expected) {
    const error = new Error("占用者已变化，未执行释放。请刷新后重新确认。");
    error.status = 409;
    throw error;
  }
}
