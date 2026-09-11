import type {
  PushDeliveryResult,
  PushEnvironment,
} from "@runweave/shared/device-notifications";
export interface Sender {
  hostId: string;
  environments: PushEnvironment[];
  revoked?: boolean;
}
export interface Subscription {
  id: string;
  hostId: string;
  installationId: string;
  environment: PushEnvironment;
  deviceToken: string;
  displayName: string;
  version: number;
  revoked: boolean;
  revokeToken: string;
  invalidToken?: string;
}
export interface Delivery {
  id: string;
  hostId: string;
  subscriptionId: string;
  cycleId: string;
  state: PushDeliveryResult["state"] | "sending";
  attempts: number;
  createdAt: number;
  updatedAt: number;
  retryAfterMs?: number;
}
export interface GatewayData {
  schemaVersion: 1;
  senders: Record<string, Sender>;
  subscriptions: Record<string, Subscription>;
  deliveries: Record<string, Delivery>;
  completedCycles?: Record<string, number>;
}
