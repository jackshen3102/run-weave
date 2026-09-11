export type PushEnvironment = "sandbox" | "production";
export interface DeviceNotificationRegistration {
  connectionId: string;
  deviceToken: string;
  environment: PushEnvironment;
  displayName: string;
  enabled: boolean;
  explicitEnable?: boolean;
}
export interface DeviceNotificationSubscription {
  subscriptionId: string;
  hostId: string;
  installationId: string;
  environment: PushEnvironment;
  state: "enabled" | "pending" | "disabled";
  version: number;
  gatewayURL: string | null;
  revokeToken?: string | null;
}
export interface BatteryNotification {
  notificationId: string;
  subscriptionId: string;
  cycleId: string;
  level: 10 | 20;
  percent: number;
  observedAt: string;
}
export type PushDeliveryState = "accepted" | "unknown" | "retry" | "failed";
export interface PushDeliveryResult {
  state: PushDeliveryState;
  retryAfterMs?: number;
}
