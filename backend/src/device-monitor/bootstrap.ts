import path from "node:path";
import type { AuthService } from "../auth/service";
import { logger } from "../logging/index";
import { BatteryAlerts } from "./delivery";
import { PushClient } from "./push-client";
import { DeviceMonitorService } from "./service";
import { DeviceMonitorStore } from "./store";
import { DeviceSubscriptions } from "./subscriptions";
export interface DeviceMonitoringRuntime {
  deviceMonitor: DeviceMonitorService | null;
  batteryAlerts: BatteryAlerts | null;
}
export async function createDeviceMonitor(
  profileDirectory: string,
  auth: AuthService,
) {
  let monitor: DeviceMonitorService | null = null;
  let alerts: BatteryAlerts | null = null;
  try {
    monitor = new DeviceMonitorService(
      await DeviceMonitorStore.create(
        path.join(profileDirectory, "device-monitor"),
      ),
    );
    let push: PushClient | null = null;
    try {
      push = PushClient.configured(monitor.snapshot().hostId);
    } catch {
      logger.warn("device-monitor.push.configuration.invalid");
    }
    alerts = new BatteryAlerts(
      monitor,
      new DeviceSubscriptions(monitor.store, auth, push),
    );
    alerts.start();
    monitor.start();
  } catch {
    logger.warn("device-monitor.initialize.failed", {
      message:
        "Device monitoring unavailable; terminal services remain available",
    });
  }
  return { deviceMonitor: monitor, batteryAlerts: alerts };
}
