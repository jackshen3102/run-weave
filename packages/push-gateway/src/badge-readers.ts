import { randomBytes } from "node:crypto";
import { pushBadgeTargetIdentity, type PushBadgeReaderAccess, type PushBadgeTotal } from "@runweave/shared/push-notifications";
import { equalSecret, hash, identifier, requireValue } from "./auth";
import { activeBadgeSubscription, readBadgeSnapshot } from "./badges";
import type { GatewayStore } from "./store";
import type { Sender, Subscription } from "./types";

const targetId = (s: Subscription) => hash(pushBadgeTargetIdentity(s.environment, s.installationId));

export function issueBadgeReader(
  store: GatewayStore, sender: Sender, readerId: string, body: Record<string, unknown>, now = Date.now(),
): PushBadgeReaderAccess {
  requireValue(Object.keys(body).length === 1 && identifier(body.subscriptionId));
  const subscriptionId = body.subscriptionId as string;
  const readToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now + 300_000).toISOString();
  return store.update((data) => {
    const source = data.subscriptions[subscriptionId];
    requireValue(source && source.hostId === sender.hostId && sender.environments.includes(source.environment), 403);
    requireValue(activeBadgeSubscription(data, source), 410);
    const target = targetId(source);
    const readers = data.badgeReaders ??= {};
    const previous = readers[readerId];
    requireValue(!previous || previous.issuerHostId === sender.hostId &&
      previous.sourceSubscriptionId === subscriptionId && previous.targetId === target, 403);
    for (const [id, reader] of Object.entries(readers)) {
      if (Date.parse(reader.expiresAt) <= now) delete readers[id];
    }
    requireValue(readers[readerId] || Object.values(readers).filter((r) => r.issuerHostId === sender.hostId).length < 100, 429);
    readers[readerId] = {
      issuerHostId: sender.hostId, sourceSubscriptionId: subscriptionId,
      targetId: target, tokenHash: hash(readToken), expiresAt,
    };
    return { targetId: target, readerId, readToken, expiresAt };
  });
}

export function readBadgeReader(
  store: GatewayStore, readerId: string, token: string, now = Date.now(),
): PushBadgeTotal {
  const data = store.snapshot();
  const reader = data.badgeReaders?.[readerId];
  requireValue(reader && token && equalSecret(hash(token), reader.tokenHash) && Date.parse(reader.expiresAt) > now, 401);
  const source = data.subscriptions[reader.sourceSubscriptionId];
  requireValue(source && source.hostId === reader.issuerHostId && activeBadgeSubscription(data, source) &&
    targetId(source) === reader.targetId, 410);
  return { targetId: reader.targetId, ...readBadgeSnapshot(data, source) };
}
