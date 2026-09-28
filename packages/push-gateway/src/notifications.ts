import type { PushNotificationRequest } from "@runweave/shared/push-notifications";
import type { APNsTransport } from "./apns";
import { categoryName, identifier, requireValue } from "./auth";
import { deliver } from "./delivery";
import type { GatewayStore } from "./store";
import type { Sender } from "./types";

export function deliverNotification(
  store: GatewayStore,
  sender: Sender,
  body: Record<string, unknown>,
  transport: APNsTransport,
) {
  requireValue(
    Object.keys(body).every((key) =>
      [
        "subscriptionId",
        "eventId",
        "category",
        "title",
        "body",
        "occurredAt",
        "target",
      ].includes(key),
    ),
  );
  requireValue(identifier(body.subscriptionId) && identifier(body.eventId));
  requireValue(categoryName(body.category));
  requireValue(
    typeof body.title === "string" &&
      body.title.trim().length > 0 &&
      body.title.length <= 120,
  );
  requireValue(
    typeof body.body === "string" &&
      body.body.trim().length > 0 &&
      body.body.length <= 2000,
  );
  requireValue(
    typeof body.occurredAt === "string" &&
      Number.isFinite(Date.parse(body.occurredAt)),
  );
  if (body.target !== undefined) {
    requireValue(typeof body.target === "object" && body.target !== null && !Array.isArray(body.target));
    const target = body.target as Record<string, unknown>;
    requireValue(Object.keys(target).length === 2 &&
      target.resourceType === "scheduled-run" &&
      typeof target.resourceId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(target.resourceId));
  }
  const age = Date.now() - Date.parse(body.occurredAt);
  requireValue(age >= -30_000 && age <= 300_000, 422, "Stale event");
  const event = body as unknown as PushNotificationRequest;
  return deliver(store, sender, event, transport);
}
