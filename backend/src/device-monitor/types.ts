import type { PushEnvironment } from "@runweave/shared/push-notifications";

export interface DeviceSubscription {
  id: string;
  installationId: string;
  connectionId: string;
  username: string;
  sessionId: string;
  environment: PushEnvironment;
  deviceToken: string;
  displayName: string;
  version: number;
  enabled: boolean;
  synced: boolean;
  confirmed?: boolean;
  revokeToken: string | null;
}

export interface DeviceDelivery {
  id: string;
  cycleId: string;
  level: 10 | 20;
  target: string;
  state:
    | "pending"
    | "sending"
    | "accepted"
    | "unknown"
    | "cancelled"
    | "failed";
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
  notification?: { title: string; body: string; occurredAt: string };
}

export interface DeviceMonitorData {
  schemaVersion: 1;
  hostId: string;
  cycle: { id: string; highest: 10 | 20; startedAt: number } | null;
  endedCycles?: Record<string, number>;
  subscriptions: Record<string, DeviceSubscription>;
  deliveries: Record<string, DeviceDelivery>;
}
