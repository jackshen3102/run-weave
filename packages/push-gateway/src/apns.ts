import { connect } from "node:http2";
import { sign } from "node:crypto";
import type { PushDeliveryResult } from "@runweave/shared/push-notifications";
import type { ProviderNotification, Subscription } from "./types";
import type { APNsConfiguration } from "./config";
import { requireValue } from "./auth";
export type APNsResult = PushDeliveryResult & { invalidToken?: boolean };
export type APNsTransport = (
  subscription: Subscription,
  alert: ProviderNotification,
) => Promise<APNsResult>;

export function encodePayload(
  subscription: Subscription,
  notification: ProviderNotification,
): string {
  const payload = JSON.stringify({
    aps: {
      alert: { title: notification.title, body: notification.body },
      sound: "default",
    },
    protocolVersion: 1,
    hostId: subscription.hostId,
    notificationId: notification.notificationId,
    category: notification.category,
    occurredAt: notification.occurredAt,
  });
  requireValue(
    Buffer.byteLength(payload, "utf8") <= 4096,
    413,
    "Notification payload too large",
  );
  return payload;
}

export function createAPNsTransport(
  config: APNsConfiguration,
  connectToAPNs: typeof connect = connect,
): APNsTransport {
  let token = "";
  let tokenAt = 0;
  return async (subscription, alert) => {
    const payload = encodePayload(subscription, alert);
    if (!token || Date.now() - tokenAt > 45 * 60_000) {
      tokenAt = Date.now();
      const header = Buffer.from(
        JSON.stringify({ alg: "ES256", kid: config.keyId }),
      ).toString("base64url");
      const claims = Buffer.from(
        JSON.stringify({ iss: config.teamId, iat: Math.floor(tokenAt / 1000) }),
      ).toString("base64url");
      const content = `${header}.${claims}`;
      token = `${content}.${sign("sha256", Buffer.from(content), { key: config.key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    }
    const endpoint =
      subscription.environment === "sandbox"
        ? "api.sandbox.push.apple.com"
        : "api.push.apple.com";
    return new Promise((resolve) => {
      const client = connectToAPNs(`https://${endpoint}`);
      let settled = false;
      const finish = (result: APNsResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        client.destroy();
        resolve(result);
      };
      const timeout = setTimeout(() => finish({ state: "unknown" }), 10_000);
      client.on("error", () => finish({ state: "unknown" }));
      client.on("connect", () => {
        if (settled) return;
        const request = client.request({
          ":method": "POST",
          ":path": `/3/device/${subscription.deviceToken}`,
          authorization: `bearer ${token}`,
          "apns-topic": config.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": "0",
          "apns-collapse-id": alert.notificationId,
        });
        let status = 0;
        let retryAfterMs = 0;
        let body = "";
        request.on("response", (headers) => {
          status = Number(headers[":status"]);
          const retry = String(headers["retry-after"] ?? "");
          retryAfterMs = /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : Math.max(0, Date.parse(retry) - Date.now()) || 0;
        });
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          if (body.length < 8192) body += chunk;
        });
        request.on("error", () => finish({ state: "unknown" }));
        request.on("end", () => {
          if (status === 200) {
            finish({ state: "accepted" });
            return;
          }
          if (status === 429 || status >= 500) {
            finish({ state: "retry", retryAfterMs });
            return;
          }
          let reason = "";
          try {
            reason = JSON.parse(body).reason;
          } catch {
            /* No raw response logging. */
          }
          finish({
            state: "failed",
            invalidToken: [
              "BadDeviceToken",
              "DeviceTokenNotForTopic",
              "Unregistered",
            ].includes(reason),
          });
        });
        request.end(payload);
      });
    });
  };
}
