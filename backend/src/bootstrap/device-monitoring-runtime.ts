import path from "node:path";
import type { AuthService } from "../auth/service";
import { createDeviceMonitor } from "../device-monitor/bootstrap";
import { DesktopBadgeAccess } from "../device-monitor/desktop-badge-access";
import { ScheduledTaskAlerts } from "../device-monitor/scheduled-task-alerts";
import { TerminalBadges } from "../device-monitor/terminal-badges";
import { TerminalReplyNotifications } from "../device-monitor/terminal-replies";
import { logger } from "../logging/index";
import { ResourceMonitorService } from "../resource-monitor/service";
import { ResourceMonitorStore } from "../resource-monitor/store";
import type { RuntimeStatusWorkspaceServiceManager } from "../runtime-status/workspace-service-manager";
import type { ScheduledTaskSubsystem } from "../scheduled-tasks/bootstrap";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import type { TerminalEventService } from "../terminal/state/terminal-event-service";
import type { ResourceScope } from "./resource-scope";

export async function createDeviceMonitoringRuntime(
  resources: ResourceScope,
  input: {
    browserProfileDir: string;
    authService: AuthService;
    terminalSessionManager: TerminalSessionManager;
    terminalEventService: TerminalEventService;
    workspaceServiceManager: RuntimeStatusWorkspaceServiceManager;
    scheduledTaskStore: ScheduledTaskSubsystem["store"];
  },
) {
  const deviceMonitoring = await createDeviceMonitor(
    input.browserProfileDir,
    input.authService,
  );
  resources.defer("push-configuration", deviceMonitoring.disposeConfiguration);
  resources.defer("device-monitor", () =>
    deviceMonitoring.deviceMonitor?.dispose(),
  );
  resources.defer("battery-alerts", () =>
    deviceMonitoring.batteryAlerts?.dispose(),
  );

  let resourceMonitor: ResourceMonitorService | null = null;
  if (deviceMonitoring.deviceMonitor) {
    let resourceStore: ResourceMonitorStore | null = null;
    try {
      resourceStore = await ResourceMonitorStore.create(
        path.join(input.browserProfileDir, "resource-monitor"),
      );
      resourceMonitor = new ResourceMonitorService(
        resourceStore,
        deviceMonitoring.deviceMonitor,
        input.workspaceServiceManager,
      );
      resources.defer("resource-monitor", () => resourceMonitor?.dispose());
      resourceMonitor.start();
    } catch {
      await resourceStore?.close();
      logger.warn("resource-monitor.initialize.failed");
    }
  }

  const terminalBadges = deviceMonitoring.batteryAlerts
    ? new TerminalBadges(
        input.terminalSessionManager,
        input.terminalEventService,
        deviceMonitoring.batteryAlerts.subscriptions,
      )
    : null;
  if (deviceMonitoring.batteryAlerts) {
    const mobileReplies = new TerminalReplyNotifications(
      input.terminalSessionManager,
      deviceMonitoring.batteryAlerts.subscriptions,
    );
    input.terminalSessionManager.mobileReplies = mobileReplies;
    resources.defer("terminal-replies", async () => {
      input.terminalSessionManager.mobileReplies = undefined;
      await mobileReplies.dispose();
    });
    await mobileReplies.start();
  }
  resources.defer("terminal-badges", () => terminalBadges?.dispose());

  const desktopBadgeAccess = deviceMonitoring.batteryAlerts
    ? new DesktopBadgeAccess(
        input.authService,
        deviceMonitoring.batteryAlerts.subscriptions,
      )
    : null;
  const taskAlerts =
    input.scheduledTaskStore && deviceMonitoring.batteryAlerts
      ? new ScheduledTaskAlerts(
          input.scheduledTaskStore,
          deviceMonitoring.batteryAlerts.subscriptions,
        )
      : null;
  if (taskAlerts) {
    resources.defer("scheduled-task-alerts", () => taskAlerts.dispose());
  }

  return {
    deviceMonitoring,
    resourceMonitor,
    terminalBadges,
    desktopBadgeAccess,
    taskAlerts,
  };
}
