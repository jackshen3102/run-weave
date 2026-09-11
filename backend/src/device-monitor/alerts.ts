import { createHash, randomUUID } from "node:crypto";
import {
  batteryAlertLevel,
  DEVICE_SAMPLE_FRESH_MS,
  type DeviceStatusSnapshot,
} from "@runweave/shared/device-status";
import type { DeviceMonitorData, DeviceSubscription } from "./types";
export const targetFor = (s: DeviceSubscription): string =>
  `${s.installationId}:${s.environment}`;
export function updateAlerts(
  data: DeviceMonitorData,
  snapshot: DeviceStatusSnapshot,
  recipients: DeviceSubscription[],
  now = Date.now(),
): void {
  const level = batteryAlertLevel(snapshot);
  const fresh =
    snapshot.sampleStatus === "ok" &&
    snapshot.sampleAgeMs !== null &&
    snapshot.sampleAgeMs <= DEVICE_SAMPLE_FRESH_MS;
  if (
    fresh &&
    snapshot.battery.percent !== null &&
    snapshot.battery.percent >= 25 &&
    data.cycle
  ) {
    (data.endedCycles ??= {})[data.cycle.id] = now;
    data.cycle = null;
  }
  if (level && !data.cycle)
    data.cycle = { id: randomUUID(), highest: level, startedAt: now };
  if (data.cycle && level === 10) data.cycle.highest = 10;
  const targets = new Set(recipients.map(targetFor));
  for (const delivery of Object.values(data.deliveries)) {
    if (delivery.state === "sending") delivery.state = "unknown";
    if (delivery.state !== "pending") continue;
    if (
      !level ||
      delivery.level !== level ||
      delivery.cycleId !== data.cycle?.id ||
      !targets.has(delivery.target) ||
      now - delivery.createdAt > 300_000
    )
      delivery.state = "cancelled";
  }
  if (level && data.cycle && level === data.cycle.highest) {
    for (const target of targets) {
      const id = createHash("sha256")
        .update(`${data.hostId}:${data.cycle.id}:${level}:${target}`)
        .digest("hex");
      if (!data.deliveries[id])
        data.deliveries[id] = {
          id,
          cycleId: data.cycle.id,
          level,
          target,
          state: "pending",
          attempts: 0,
          createdAt: now,
          nextAttemptAt: now,
        };
    }
  }
  for (const [id, endedAt] of Object.entries(data.endedCycles ?? {})) {
    if (now - endedAt < 7 * 24 * 3600_000) continue;
    for (const [key, value] of Object.entries(data.deliveries))
      if (value.cycleId === id) delete data.deliveries[key];
    delete data.endedCycles![id];
    delete data.syncedCycles?.[id];
  }
}
