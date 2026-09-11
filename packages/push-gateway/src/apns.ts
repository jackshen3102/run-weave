import { connect } from "node:http2";
import { sign } from "node:crypto";
import type {
  BatteryNotification,
  PushDeliveryResult,
} from "@runweave/shared/device-notifications";
import type { Subscription } from "./types";
import type { APNsConfiguration } from "./config";
import { hash } from "./auth";
export type APNsResult = PushDeliveryResult & { invalidToken?: boolean };
export type APNsTransport = (
  subscription: Subscription,
  alert: BatteryNotification,
) => Promise<APNsResult>;

export function createAPNsTransport(
  config: APNsConfiguration,
  connectToAPNs: typeof connect = connect,
): APNsTransport {
  let token = "";
  let tokenAt = 0;
  return async (subscription, alert) => {
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
          "apns-collapse-id": hash(subscription.hostId).slice(0, 40),
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
        request.end(
          JSON.stringify({
            aps: {
              alert: {
                title: `${subscription.displayName} 电量低`,
                body: `${alert.percent}%，正在使用电池，请连接电源。`,
              },
              sound: "default",
            },
            protocolVersion: 1,
            hostId: subscription.hostId,
            notificationId: alert.notificationId,
            level: alert.level,
            percent: alert.percent,
            observedAt: alert.observedAt,
          }),
        );
      });
    });
  };
}
