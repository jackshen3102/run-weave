import type {
  BatteryNotification,
  PushDeliveryResult,
} from "@runweave/shared/device-notifications";
import type { APNsTransport } from "./apns";
import { hash, identifier, requireValue } from "./auth";
import type { GatewayStore } from "./store";
import type { Sender } from "./types";

export async function deliver(
  store: GatewayStore,
  sender: Sender,
  body: Record<string, unknown>,
  transport: APNsTransport,
): Promise<PushDeliveryResult> {
  requireValue(
    Object.keys(body).every((key) =>
      [
        "notificationId",
        "subscriptionId",
        "cycleId",
        "level",
        "percent",
        "observedAt",
      ].includes(key),
    ),
  );
  requireValue(
    identifier(body.notificationId) &&
      identifier(body.subscriptionId) &&
      identifier(body.cycleId),
  );
  requireValue(body.level === 10 || body.level === 20);
  requireValue(
    Number.isInteger(body.percent) &&
      Number(body.percent) >= 0 &&
      Number(body.percent) <= Number(body.level),
  );
  requireValue(
    typeof body.observedAt === "string" &&
      Number.isFinite(Date.parse(body.observedAt)),
  );
  const age = Date.now() - Date.parse(body.observedAt);
  requireValue(age >= -30_000 && age <= 300_000, 422, "Stale observation");
  const alert = body as unknown as BatteryNotification;
  const claim = store.update((data) => {
    requireValue(
      !data.completedCycles?.[`${sender.hostId}:${alert.cycleId}`],
      410,
      "Cycle completed",
    );
    const subscription = data.subscriptions[alert.subscriptionId];
    requireValue(subscription && subscription.hostId === sender.hostId, 403);
    requireValue(
      !subscription.revoked &&
        subscription.invalidToken !== subscription.deviceToken,
      410,
      "Subscription inactive",
    );
    const expectedID = hash(
      [
        sender.hostId,
        alert.cycleId,
        alert.level,
        subscription.installationId,
        subscription.environment,
      ].join(":"),
    );
    requireValue(
      alert.notificationId === expectedID,
      400,
      "Invalid notification identity",
    );
    const previous = data.deliveries[expectedID];
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
    const recent = Object.values(data.deliveries).filter(
      (d) => d.subscriptionId === subscription.id && now - d.updatedAt < 60_000,
    );
    requireValue(
      recent.reduce((sum, d) => sum + d.attempts, 0) < 4,
      429,
      "Rate limited",
    );
    data.deliveries[expectedID] = {
      id: expectedID,
      hostId: sender.hostId,
      subscriptionId: subscription.id,
      cycleId: alert.cycleId,
      state: "sending",
      attempts: (previous?.attempts ?? 0) + 1,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    return { subscription: structuredClone(subscription) };
  });
  if (claim.result) return claim.result;
  const subscription = claim.subscription!;
  // No await between the durable claim and transport: revocation cannot race a queued submission.
  const result = await transport(subscription, alert).catch(() => ({
    state: "unknown" as const,
  }));
  return store.update((data) => {
    const delivery = data.deliveries[alert.notificationId]!;
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
      state: delivery.state,
      ...(delivery.retryAfterMs ? { retryAfterMs: delivery.retryAfterMs } : {}),
    };
  });
}
