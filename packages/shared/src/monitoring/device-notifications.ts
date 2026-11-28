import type { PushEnvironment } from "../push-notifications";
export const deviceNotificationKinds = ["battery", "scheduled-task", "terminal-unread", "terminal-reply", "terminal-question"] as const;
export type DeviceNotificationKind = typeof deviceNotificationKinds[number];
export interface DeviceNotificationRegistration {
  connectionId: string;
  deviceToken: string;
  environment: PushEnvironment;
  displayName: string;
  enabled: boolean;
  explicitEnable?: boolean;
  kind?: DeviceNotificationKind;
}
export interface DeviceNotificationSubscription {
  subscriptionId: string;
  hostId: string;
  installationId: string;
  environment: PushEnvironment;
  kind: DeviceNotificationKind;
  state: "enabled" | "pending" | "disabled";
  version: number;
  gatewayURL: string | null;
  revokeToken?: string | null;
}

export type TerminalReplyNotificationResponse =
  | { status: "available"; terminalId: string; panelId: string | null }
  | { status: "closed"; terminalId: string };
