import { randomBytes } from "node:crypto";
import type { Sender, Subscription } from "./types";
import { equalSecret, identifier, requireValue } from "./auth";
import type { GatewayStore } from "./store";
export function register(
  store: GatewayStore,
  sender: Sender,
  id: string,
  body: Record<string, unknown>,
) {
  requireValue(
    Object.keys(body).every((key) =>
      [
        "installationId",
        "environment",
        "deviceToken",
        "displayName",
        "version",
      ].includes(key),
    ),
  );
  requireValue(identifier(id) && identifier(body.installationId));
  requireValue(
    body.environment === "sandbox" || body.environment === "production",
  );
  const environment = body.environment;
  requireValue(
    sender.environments.includes(environment),
    403,
    "Environment not allowed",
  );
  requireValue(
    typeof body.deviceToken === "string" &&
      /^[0-9a-f]{2,4096}$/.test(body.deviceToken) &&
      body.deviceToken.length % 2 === 0,
  );
  requireValue(
    typeof body.displayName === "string" &&
      body.displayName.length > 0 &&
      body.displayName.length <= 80,
  );
  requireValue(Number.isSafeInteger(body.version) && Number(body.version) >= 1);
  return store.update((data) => {
    const previous = data.subscriptions[id];
    requireValue(!previous || previous.hostId === sender.hostId, 403);
    requireValue(!previous?.revoked, 409, "Subscription revoked");
    if (previous) {
      requireValue(
        previous.installationId === body.installationId &&
          previous.environment === environment,
        409,
      );
      requireValue(
        Number(body.version) >= previous.version,
        409,
        "Stale version",
      );
      if (body.version === previous.version) {
        requireValue(
          body.deviceToken === previous.deviceToken &&
            body.displayName === previous.displayName,
          409,
        );
        return { revokeToken: previous.revokeToken };
      }
    } else {
      requireValue(
        Object.values(data.subscriptions).filter(
          (s) => s.hostId === sender.hostId && !s.revoked,
        ).length < 100,
        429,
      );
    }
    const value: Subscription = {
      id,
      hostId: sender.hostId,
      installationId: String(body.installationId),
      environment,
      deviceToken: String(body.deviceToken),
      displayName: String(body.displayName),
      version: Number(body.version),
      revoked: false,
      revokeToken:
        previous?.revokeToken ?? randomBytes(32).toString("base64url"),
      invalidToken:
        previous?.deviceToken === body.deviceToken
          ? previous?.invalidToken
          : undefined,
    };
    data.subscriptions[id] = value;
    return { revokeToken: value.revokeToken };
  });
}
export function revoke(
  store: GatewayStore,
  sender: Sender | null,
  id: string,
  token: string,
): void {
  store.update((data) => {
    const value = data.subscriptions[id];
    requireValue(value, 404);
    requireValue(
      sender?.hostId === value.hostId || equalSecret(token, value.revokeToken),
      403,
    );
    value.revoked = true;
    value.deviceToken = "";
  });
}
