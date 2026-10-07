import type { APNsTransport } from "./apns";
import { equalSecret, hash, requireValue } from "./auth";
import type { GatewayStore } from "./store";
import type { GatewayData, Sender, Subscription } from "./types";

const category = "terminal.unread";
const targetKey = (s: Subscription) => `${s.environment}:${s.installationId}`;
const contributionKey = (s: Subscription) => `${targetKey(s)}:${s.hostId}`;
const active = (data: GatewayData, s: Subscription) => !s.revoked && s.categories.includes(category) &&
  Object.values(data.senders).some((sender) => sender.hostId === s.hostId && !sender.revoked && sender.environments.includes(s.environment));

/** Recompute from authorized subscriptions, deduplicating aliases of the same host. */
function reconcile(data: GatewayData, source: Subscription): void {
  const key = targetKey(source);
  const subscriptions = Object.values(data.subscriptions).filter((s) =>
    targetKey(s) === key && active(data, s),
  );
  const hosts = new Set(subscriptions.map((s) => s.hostId));
  const count = [...hosts].reduce((sum, host) =>
    sum + (data.badgeContributions?.[`${key}:${host}`]?.count ?? 0), 0);
  const previous = data.badgeTargets?.[key];
  const deliverySource = subscriptions.sort((a, b) => (b.registeredAt ?? 0) - (a.registeredAt ?? 0))[0];
  const deviceToken = deliverySource?.deviceToken ?? previous?.deviceToken;
  if (!deviceToken) return;
  if (previous && previous.count === count && previous.deviceToken === deviceToken) {
    if (deliverySource) previous.subscriptionId = deliverySource.id;
    return;
  }
  (data.badgeTargets ??= {})[key] = {
    installationId: source.installationId,
    environment: source.environment,
    subscriptionId: deliverySource?.id ?? previous!.subscriptionId,
    deviceToken,
    count,
    revision: (previous?.revision ?? 0) + 1,
    deliveredRevision: previous?.deliveredRevision ?? 0,
    nextAttemptAt: 0,
  };
}

export function updateBadge(store: GatewayStore, sender: Sender, id: string, body: Record<string, unknown>): void {
  requireValue(Object.keys(body).every((key) => ["revision", "count"].includes(key)));
  requireValue(Number.isSafeInteger(body.revision) && Number(body.revision) > 0);
  requireValue(Number.isSafeInteger(body.count) && Number(body.count) >= 0 && Number(body.count) <= 1_000_000);
  store.update((data) => {
    const s = data.subscriptions[id];
    requireValue(s && s.hostId === sender.hostId && sender.environments.includes(s.environment), 403);
    requireValue(active(data, s), 410);
    const key = contributionKey(s);
    const previous = data.badgeContributions?.[key];
    if (!previous || Number(body.revision) > previous.revision) {
      (data.badgeContributions ??= {})[key] = { revision: Number(body.revision), count: Number(body.count) };
    } else if (body.revision === previous.revision) {
      requireValue(body.count === previous.count, 409, "Badge revision content changed");
    }
    // Older absolute snapshots are harmless; never roll the host contribution back.
    reconcile(data, s);
  });
}

export function readBadge(store: GatewayStore, sender: Sender | null, id: string, token: string) {
  const data = store.snapshot();
  const s = data.subscriptions[id];
  requireValue(s, 404);
  requireValue(sender?.hostId === s.hostId || equalSecret(token, s.revokeToken), 403);
  requireValue(active(data, s), 410);
  const target = data.badgeTargets?.[targetKey(s)];
  requireValue(target, 409, "Badge snapshot pending");
  return { revision: target.revision, count: target.count };
}

export function reconcileBadges(store: GatewayStore, id: string): void {
  store.update((data) => {
    const s = data.subscriptions[id];
    if (s && (s.categories.includes(category) || data.badgeTargets?.[targetKey(s)])) reconcile(data, s);
  });
}

/** One in-flight submission per installation. Pending updates collapse to the newest total. */
export class BadgeDelivery {
  private flights = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  constructor(private store: GatewayStore, private transport: APNsTransport) {}
  start(): void {
    this.store.update((data) => {
      for (const subscription of Object.values(data.subscriptions)) {
        if (subscription.categories.includes(category)) reconcile(data, subscription);
      }
    });
    this.timer = setInterval(() => this.pump(), 1_000);
    this.timer.unref();
    this.pump();
  }
  pump(): void {
    if (this.stopped) return;
    for (const [key, target] of Object.entries(this.store.snapshot().badgeTargets ?? {})) {
      if (this.flights.has(key) || target.revision <= target.deliveredRevision || target.nextAttemptAt > Date.now()) continue;
      const flight = this.send(key).catch(() => undefined).finally(() => {
        this.flights.delete(key);
        this.pump();
      });
      this.flights.set(key, flight);
    }
  }
  private async send(key: string): Promise<void> {
    const claim = this.store.update((data) => {
      const target = data.badgeTargets![key]!;
      // Persist a claim before network I/O. Repeating absolute badge state after a crash is safe.
      target.nextAttemptAt = Date.now() + 30_000;
      return structuredClone({ target, subscription: data.subscriptions[target.subscriptionId]! });
    });
    const { target, subscription } = claim;
    const result = await this.transport({ ...subscription, deviceToken: target.deviceToken }, {
      notificationId: hash(`${key}:${target.revision}`),
      category,
      title: "", body: "", occurredAt: new Date().toISOString(),
      badge: target.count, badgeRevision: target.revision,
      collapseId: hash(`badge:${key}`),
    }).catch(() => ({ state: "unknown" as const }));
    if (this.stopped) return;
    this.store.update((data) => {
      const current = data.badgeTargets![key]!;
      if (result.state === "accepted" || result.state === "failed") {
        current.deliveredRevision = Math.max(current.deliveredRevision, target.revision);
      } else if (current.revision === target.revision) {
        current.nextAttemptAt = Date.now() + Math.max(30_000, "retryAfterMs" in result ? result.retryAfterMs ?? 0 : 0);
      }
    });
  }
  async dispose(): Promise<void> {
    this.stop();
    await Promise.allSettled(this.flights.values());
  }
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }
}
