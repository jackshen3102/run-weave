import type { PushEnvironment } from "../push-notifications";
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
