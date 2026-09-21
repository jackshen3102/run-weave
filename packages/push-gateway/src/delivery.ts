import type {
  PushDeliveryResult,
  PushNotificationResult,
  PushNotificationRequest,
} from "@runweave/shared/push-notifications";
import type { APNsTransport } from "./apns";
import { encodePayload } from "./apns";
import { hash, requireValue } from "./auth";
import type { GatewayStore } from "./store";
import type { ProviderNotification, Sender } from "./types";

export async function deliver(
  store: GatewayStore,
  sender: Sender,
  event: PushNotificationRequest,
  transport: APNsTransport,
): Promise<PushNotificationResult> {
  let notification!: ProviderNotification;
  const fingerprint = hash(
    JSON.stringify([event.category, event.title, event.body, event.occurredAt]),
  );
  const claim = store.update((data) => {
    const subscription = data.subscriptions[event.subscriptionId];
    requireValue(subscription && subscription.hostId === sender.hostId, 403);
    requireValue(
      sender.environments.includes(subscription.environment),
      403,
      "Environment not allowed",
    );
    requireValue(
      !subscription.revoked &&
        subscription.invalidToken !== subscription.deviceToken,
      410,
      "Subscription inactive",
    );
    requireValue(
      subscription.categories.includes(event.category),
      403,
      "Category not subscribed",
    );
    notification = {
      notificationId: hash(
        JSON.stringify([
          "notification-v1",
          sender.hostId,
          subscription.installationId,
          subscription.environment,
          event.category,
          event.eventId,
        ]),
      ),
      category: event.category,
      title: event.title,
      body: event.body,
      occurredAt: event.occurredAt,
    };
    encodePayload(subscription, notification);
    const expectedID = notification.notificationId;
    // Generic events are fresh for five minutes; retain their claims for seven days.
    for (const [id, delivery] of Object.entries(data.deliveries)) {
      if (Date.now() - delivery.createdAt > 7 * 24 * 3600_000)
        delete data.deliveries[id];
    }
    const previous = data.deliveries[expectedID];
    requireValue(
      !previous || previous.fingerprint === fingerprint,
      409,
      "Event content changed",
    );
    if (previous && previous.state !== "retry") {
      return {
        result: {
          state: previous.state === "sending" ? "unknown" : previous.state,
        } as PushDeliveryResult,
      };
    }
    const now = Date.now();
    if (
      previous &&
      (previous.attempts >= 4 || now - previous.createdAt > 300_000)
    ) {
      previous.state = "failed";
      return { result: { state: "failed" } as PushDeliveryResult };
    }
    if (previous && now < previous.updatedAt + (previous.retryAfterMs ?? 0)) {
      return {
        result: {
          state: "retry",
          retryAfterMs: previous.updatedAt + (previous.retryAfterMs ?? 0) - now,
        } as PushDeliveryResult,
      };
    }
    const recent = Object.values(data.deliveries).filter((d) => {
      const target = data.subscriptions[d.subscriptionId];
      return (
        d.hostId === sender.hostId &&
        target?.installationId === subscription.installationId &&
        target.environment === subscription.environment &&
        now - d.updatedAt < 60_000
      );
    });
    requireValue(
      recent.reduce((sum, d) => sum + d.attempts, 0) < 4,
      429,
      "Rate limited",
    );
    data.deliveries[expectedID] = {
      id: expectedID,
      hostId: sender.hostId,
      subscriptionId: subscription.id,
      fingerprint,
      state: "sending",
      attempts: (previous?.attempts ?? 0) + 1,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    return { subscription: structuredClone(subscription) };
  });
  if (claim.result)
    return {
      ...claim.result,
      notificationId: notification.notificationId,
    };
  const subscription = claim.subscription!;
  // No await between the durable claim and transport: revocation cannot race a queued submission.
  const result = await transport(subscription, notification).catch(() => ({
    state: "unknown" as const,
  }));
  return store.update((data) => {
    const delivery = data.deliveries[notification.notificationId]!;
    delivery.state = result.state;
    delivery.updatedAt = Date.now();
    if (result.state === "retry") {
      delivery.retryAfterMs = Math.max(
        result.retryAfterMs ?? 0,
        [5_000, 30_000, 120_000][delivery.attempts - 1] ?? 120_000,
      );
    }
    const current = data.subscriptions[subscription.id];
    if (
      "invalidToken" in result &&
      result.invalidToken &&
      current?.version === subscription.version &&
      current.deviceToken === subscription.deviceToken
    ) {
      current.invalidToken = subscription.deviceToken;
    }
    return {
      notificationId: notification.notificationId,
      state: delivery.state,
      ...(delivery.retryAfterMs ? { retryAfterMs: delivery.retryAfterMs } : {}),
    };
  });
}
