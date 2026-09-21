export type PushEnvironment = "sandbox" | "production";
export type PushDeliveryState = "accepted" | "unknown" | "retry" | "failed";
export interface PushDeliveryResult {
  state: PushDeliveryState;
  retryAfterMs?: number;
}

/** Sender-authenticated registration with explicitly selected categories. */
export interface PushSubscriptionRegistration {
  installationId: string;
  environment: PushEnvironment;
  deviceToken: string;
  displayName: string;
  version: number;
  categories: string[];
}

/** POST /v1/notifications. Keep eventId and occurredAt unchanged on retries. */
export interface PushNotificationRequest {
  subscriptionId: string;
  eventId: string;
  category: string;
  title: string;
  body: string;
  occurredAt: string;
}

export interface PushNotificationResult extends PushDeliveryResult {
  notificationId: string;
}
