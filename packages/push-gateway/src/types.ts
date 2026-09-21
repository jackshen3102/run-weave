import type {
  PushDeliveryResult,
  PushEnvironment,
} from "@runweave/shared/push-notifications";
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
  categories: string[];
}
/** Provider envelope prepared by the delivery engine, never accepted as raw HTTP input. */
export interface ProviderNotification {
  notificationId: string;
  category: string;
  title: string;
  body: string;
  occurredAt: string;
}
export interface Delivery {
  id: string;
  hostId: string;
  subscriptionId: string;
  fingerprint: string;
  state: PushDeliveryResult["state"] | "sending";
  attempts: number;
  createdAt: number;
  updatedAt: number;
  retryAfterMs?: number;
}
export interface GatewayData {
  schemaVersion: 2;
  senders: Record<string, Sender>;
  subscriptions: Record<string, Subscription>;
  deliveries: Record<string, Delivery>;
}
