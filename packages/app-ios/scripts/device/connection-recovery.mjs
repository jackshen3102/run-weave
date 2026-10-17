// Keep the existing device_unavailable gate; explain which observation failed.
export function describeConnectionFailure(expectedUDID, details, lock) {
  const device = details.value;
  const failure = (reason, query, result) => ({
    reason,
    query,
    timedOut: result.timedOut === true,
    tunnelState: device?.connectionProperties?.tunnelState ?? null,
    transport: device?.connectionProperties?.transportType ?? null,
    evidencePath: result.evidencePath ?? null,
  });
  if (!details.ok)
    return failure(
      details.timedOut ? "details_timeout" : "details_failed",
      "details",
      details,
    );
  if (device?.hardwareProperties?.udid !== expectedUDID)
    return failure("device_identity_mismatch", "details", details);
  if (device?.connectionProperties?.tunnelState !== "connected")
    return failure("tunnel_not_connected", "details", details);
  if (!lock.ok)
    return failure(
      lock.timedOut ? "lock_state_timeout" : "lock_state_failed",
      "lockState",
      lock,
    );
  if (lock.value?.deviceIdentifier !== device.identifier)
    return failure("lock_device_mismatch", "lockState", lock);
  return null;
}

export function connectionRecoveryAction(device) {
  return `Inspect iPhone ${device} in Xcode > Window > Devices and Simulators (use CUA when available). Observe Connected, Preparing or Disconnected; allow up to 120 seconds for wireless recovery, then rerun the same command after fresh preflight. Wi-Fi is supported; USB is not required. Unverified dependent checks do not prove pairing or Developer Mode is disabled.`;
}
