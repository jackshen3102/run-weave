export interface DeviceBattery {
  presence: "present" | "absent" | "unknown";
  percent: number | null;
  powerSource: "battery" | "ac" | "unknown";
  chargeState: "charging" | "discharging" | "full" | "not_charging" | "unknown";
  remainingMinutes: number | null;
}

export interface DeviceStatusSnapshot {
  protocolVersion: 1;
  hostId: string;
  streamId: string;
  revision: number;
  sampleStatus: "pending" | "ok" | "error" | "unsupported";
  observedAt: string | null;
  sampleAgeMs: number | null;
  battery: DeviceBattery;
}

export const DEVICE_SAMPLE_INTERVAL_MS = 60_000;
export const DEVICE_SAMPLE_FRESH_MS = 180_000;

export function unknownBattery(): DeviceBattery {
  return {
    presence: "unknown",
    percent: null,
    powerSource: "unknown",
    chargeState: "unknown",
    remainingMinutes: null,
  };
}

export function batteryAlertLevel(
  snapshot: DeviceStatusSnapshot,
): 10 | 20 | null {
  const battery = snapshot.battery;
  if (
    snapshot.sampleStatus !== "ok" ||
    snapshot.sampleAgeMs === null ||
    snapshot.sampleAgeMs > DEVICE_SAMPLE_FRESH_MS ||
    battery.presence !== "present" ||
    battery.powerSource !== "battery" ||
    battery.percent === null
  )
    return null;
  return battery.percent <= 10 ? 10 : battery.percent <= 20 ? 20 : null;
}
