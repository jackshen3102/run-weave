import { strict as assert } from "node:assert";
import { generateKeyPairSync, verify, randomUUID } from "node:crypto";
import { createSecureServer, connect } from "node:http2";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createAPNsTransport } from "../../../packages/push-gateway/src/apns";
import type { Subscription } from "../../../packages/push-gateway/src/types";

export async function verifyProvider() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const server = createSecureServer({
    cert: await readFile(process.env.BATTERY_FIXTURE_CERT!),
    key: await readFile(process.env.BATTERY_FIXTURE_KEY!),
  });
  let status = 200,
    calls = 0;
  const failures: Error[] = [];
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (value) => {
      body += value;
    });
    stream.on("end", () => {
      try {
        calls++;
        assert.equal(headers["apns-topic"], "com.runweave.app.native");
        assert.equal(headers["apns-push-type"], "alert");
        assert.equal(headers["apns-priority"], "10");
        assert.equal(headers["apns-expiration"], "0");
        assert.ok(String(headers["apns-collapse-id"]).length <= 64);
        const jwt = String(headers.authorization).slice(7).split(".");
        assert.equal(
          JSON.parse(Buffer.from(jwt[0]!, "base64url").toString()).alg,
          "ES256",
        );
        assert.equal(
          JSON.parse(Buffer.from(jwt[1]!, "base64url").toString()).iss,
          "fixture-team",
        );
        assert.ok(
          verify(
            "sha256",
            Buffer.from(`${jwt[0]}.${jwt[1]}`),
            { key: publicKey, dsaEncoding: "ieee-p1363" },
            Buffer.from(jwt[2]!, "base64url"),
          ),
        );
        const notification = JSON.parse(body);
        assert.equal(notification.protocolVersion, 1);
        assert.equal(
          notification.aps.alert.body,
          "18%，正在使用电池，请连接电源。",
        );
        assert.equal(notification.aps["content-available"], undefined);
        assert.equal(notification.url, undefined);
      } catch (error) {
        failures.push(error as Error);
      }
      stream.respond({
        ":status": status,
        ...(status === 429 ? { "retry-after": "7" } : {}),
      });
      stream.end(
        status === 200
          ? ""
          : JSON.stringify({
              reason: status === 410 ? "Unregistered" : "TooManyRequests",
            }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const endpoints: string[] = [];
  const transport = createAPNsTransport(
    {
      keyId: "fixture-key",
      teamId: "fixture-team",
      key: privateKey,
      topic: "com.runweave.app.native",
    },
    ((endpoint: string) => {
      endpoints.push(endpoint);
      return connect(
        `https://localhost:${(server.address() as AddressInfo).port}`,
      );
    }) as typeof connect,
  );
  const subscription: Subscription = {
    id: randomUUID(),
    hostId: randomUUID(),
    installationId: randomUUID(),
    environment: "sandbox",
    deviceToken: "ab".repeat(96),
    displayName: "Fixture Mac",
    version: 1,
    revoked: false,
    revokeToken: "fixture-only",
  };
  const alert = {
    notificationId: "ab".repeat(32),
    subscriptionId: subscription.id,
    cycleId: randomUUID(),
    level: 20 as const,
    percent: 18,
    observedAt: new Date().toISOString(),
  };
  try {
    assert.equal((await transport(subscription, alert)).state, "accepted");
    status = 429;
    assert.deepEqual(await transport(subscription, alert), {
      state: "retry",
      retryAfterMs: 7000,
    });
    status = 410;
    assert.deepEqual(
      await transport({ ...subscription, environment: "production" }, alert),
      { state: "failed", invalidToken: true },
    );
    assert.deepEqual(endpoints, [
      "https://api.sandbox.push.apple.com",
      "https://api.sandbox.push.apple.com",
      "https://api.push.apple.com",
    ]);
    assert.equal(calls, 3);
    if (failures.length) throw failures[0];
    process.stdout.write(
      "PASS real provider HTTP/2 + TLS, ES256 JWT, fixed APNs template/headers and 429/410 mapping (local APNs boundary)\n",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
