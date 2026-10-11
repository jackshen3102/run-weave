import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { TerminalBadgeClient } from "../../../electron/src/monitoring/terminal-badge-client";
import { PushClient } from "../../../backend/src/device-monitor/push-client";
import { GatewayStore } from "../../../packages/push-gateway/src/store";
import { createGateway } from "../../../packages/push-gateway/src/app";
import { hash } from "../../../packages/push-gateway/src/auth";
import type { TerminalBadgeGatewayAccess } from "../../../packages/shared/src/terminal/unread";
import { close, eventually, fixture, listen, pause } from "./fixture";
import { verifyUnreadSessions } from "./unread-sessions";
import { verifyUnreadCompatibility } from "./unread-compatibility";

/** Real authenticated Backend HTTP -> gateway HTTPS -> SQLite, without contacting Apple. */
export async function verifyUnread() {
  let clock = Date.now();
  const messages: number[] = [];
  const first = await fixture(async () => null, async (_s, n) => { if (n.badge !== undefined) messages.push(n.badge); return { state: "accepted" }; }, () => clock);
  const fixtures = [first];
  let client: TerminalBadgeClient | undefined;
  try {
    for (let i = 0; i < 2; i++) fixtures.push(await fixture(async () => null, async () => ({ state: "accepted" })));
    const installationId = randomUUID();
    const hosts = [];
    for (const f of fixtures) {
      const credential = randomUUID();
      first.gatewayStore.update((data) => { data.senders[hash(credential)] = { hostId: f.monitor.snapshot().hostId, environments: ["sandbox"] }; });
      f.subscriptions.replacePushClient(new PushClient(first.gatewayURL, credential, f.monitor.snapshot().hostId));
      const phone = await f.login();
      const desktop = await f.login(randomUUID(), "electron");
      const binding = await f.subscriptions.register(phone.sessionId, installationId, {
        connectionId: phone.connectionId, kind: "terminal-unread", enabled: true,
        environment: "sandbox", deviceToken: "ab".repeat(48), displayName: "Unread integration",
      });
      assert.ok(binding);
      await f.subscriptions.confirm(phone.sessionId, installationId, binding.subscriptionId, binding.version);
      hosts.push({ f, phone, desktop, binding, credential });
    }
    const h = hosts[0]!;
    const accessPath = "/api/terminal/unread/gateway-access";
    const targetsPath = "/api/terminal/unread/gateway-targets";
    const authorize = async () => {
      const response = await h.f.request(accessPath, h.desktop.accessToken, "POST", { subscriptionId: h.binding.subscriptionId });
      assert.equal(response.status, 200);
      return await response.json() as TerminalBadgeGatewayAccess;
    };
    let access = await authorize();
    const read = (a = access) => first.gatewayRequest("/v1/badge-readers/" + a.readerId, undefined, "GET", a.readToken);
    const phoneRead = () => first.gatewayRequest("/v1/badges/" + h.binding.subscriptionId, undefined, "GET", h.binding.revokeToken!);
    assert.equal((await read()).status, 409);
    for (const host of hosts.slice(0, 2)) await host.f.subscriptions.push!.updateBadge(host.binding.subscriptionId, { count: 0, revision: 1 });
    assert.equal((await read()).status, 409);
    assert.equal((await phoneRead()).status, 409);
    assert.equal(messages.length, 0, "missing contributions are not zero APNs badges");
    for (const [i, host] of hosts.entries()) await host.f.subscriptions.push!.updateBadge(host.binding.subscriptionId, { count: [2, 3, 1][i]!, revision: 2 });
    assert.equal((await (await read()).json()).count, 6);
    assert.equal((await (await phoneRead()).json()).count, 6);
    const alias = randomUUID();
    assert.equal((await first.gatewayRequest("/v1/subscriptions/" + alias, {
      installationId, environment: "sandbox", deviceToken: "ab".repeat(48), displayName: "Alias", version: 1, categories: ["terminal.unread"],
    }, "PUT", h.credential)).status, 200);
    await first.gatewayRequest("/v1/badges/" + alias, { revision: 2, count: 2 }, "PUT", h.credential);
    assert.equal((await (await read()).json()).count, 6);
    await h.f.subscriptions.push!.updateBadge(h.binding.subscriptionId, { count: 1, revision: 3 });
    await h.f.subscriptions.push!.updateBadge(h.binding.subscriptionId, { count: 1, revision: 3 });
    await h.f.subscriptions.push!.updateBadge(h.binding.subscriptionId, { count: 2, revision: 2 });
    assert.equal((await (await read()).json()).count, 5);
    assert.equal((await first.gatewayRequest("/v1/badges/" + alias, { revision: 3, count: 4 }, "PUT", h.credential)).status, 409);
    console.log("PASS unread aggregation: 3 hosts, alias dedupe, pending snapshots, version replay and conflict");
    await verifyUnreadCompatibility(first.directory, first.gatewayStore.snapshot(), h.binding.subscriptionId, h.credential);

    for (const host of hosts) {
      const targets = await (await host.f.request(targetsPath, host.desktop.accessToken)).json();
      assert.equal(targets.targets.length, 1);
      assert.equal(targets.targets[0].targetId, access.targetId);
      assert.equal((await host.f.request(targetsPath, host.phone.accessToken)).status, 403);
      assert.equal((await host.f.request(accessPath, host.phone.accessToken, "POST", { subscriptionId: host.binding.subscriptionId })).status, 403);
    }
    const web = await h.f.login(randomUUID(), "web");
    assert.equal((await h.f.request(targetsPath, web.accessToken)).status, 403);
    assert.equal((await h.f.request(accessPath, h.desktop.accessToken, "POST", { subscriptionId: hosts[1]!.binding.subscriptionId })).status, 403);
    for (const [route, method, body] of [
      ["/v1/badges/" + h.binding.subscriptionId, "PUT", { revision: 4, count: 0 }],
      ["/v1/subscriptions/" + h.binding.subscriptionId, "DELETE", undefined],
      ["/v1/subscriptions/" + randomUUID(), "PUT", {}],
      ["/v1/badge-readers/" + randomUUID(), "PUT", { subscriptionId: h.binding.subscriptionId }],
      ["/v1/notifications", "POST", {}],
    ] as const) assert.ok((await first.gatewayRequest(route, body, method, access.readToken)).status >= 400);
    assert.equal((await first.gatewayRequest("/v1/badge-readers/" + randomUUID(), undefined, "GET", access.readToken)).status, 401);
    assert.equal((await first.gatewayRequest("/v1/badge-readers/" + access.readerId,
      { subscriptionId: hosts[1]!.binding.subscriptionId }, "PUT", hosts[1]!.credential)).status, 403);
    const old = access;
    access = await authorize();
    assert.equal((await read(old)).status, 401);
    assert.equal(Object.keys(first.gatewayStore.snapshot().badgeReaders!).length, 1);
    assert.equal(Date.parse(access.expiresAt) - clock, 300_000);
    clock += 300_001;
    assert.equal((await read()).status, 401);
    access = await authorize();
    assert.equal((await read()).status, 200);
    console.log("PASS unread access: desktop ownership, read-only scope, cross-host overwrite denial, rotation and expiry");

    const directory = path.join(first.directory, "reader-recovery");
    let recovered = new GatewayStore(directory);
    recovered.update((data) => Object.assign(data, first.gatewayStore.snapshot()));
    recovered.close();
    recovered = new GatewayStore(directory);
    const server = createGateway(recovered, async () => ({ state: "accepted" }), undefined, () => clock);
    const port = await listen(server);
    try {
      const response = await fetch("http://localhost:" + port + "/v1/badge-readers/" + access.readerId, { headers: { Authorization: "Bearer " + access.readToken } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).count, 5);
      assert.equal(recovered.snapshot().badgeReaders![access.readerId]!.expiresAt, access.expiresAt);
    } finally { await server.disposeBadges(); await close(server); recovered.close(); }
    console.log("PASS unread SQLite restart: total, revision and reader expiration retained");

    let gatewayReads = 0;
    let oldBackendReads = 0;
    let offline = false;
    let backendOffline = false;
    let deniedRenewals = 0;
    let clientTimeOffset = clock - Date.now();
    let holdResponse = false;
    let releaseResponse: (() => void) | undefined;
    const displays: Array<number | null> = [];
    client = new TerminalBadgeClient(async (url, init) => {
      if (url.includes("/v1/badge-readers/")) { gatewayReads++; if (offline) throw new Error("isolated outage"); }
      if (url.endsWith("/api/terminal/unread")) oldBackendReads++;
      if (backendOffline && url.endsWith("/gateway-access")) { deniedRenewals++; throw new Error("isolated Backend outage"); }
      const response = await fetch(url, init);
      if (holdResponse && url.includes("/v1/badge-readers/")) await new Promise<void>((resolve) => { releaseResponse = resolve; });
      return response;
    }, (count) => displays.push(count), () => Date.now() + clientTimeOffset);
    client.setConnections(hosts.map((host, i) => ({ id: String(i), url: host.f.baseURL, token: host.desktop.accessToken })));
    await eventually(() => client!.getStatus().state === "ready");
    assert.equal(client.getStatus().count, 5);
    const baseline = gatewayReads;
    await pause(60_000);
    assert.ok(gatewayReads - baseline >= 29 && gatewayReads - baseline <= 31, "one gateway query per 2s");
    assert.equal(oldBackendReads, 0);
    offline = true;
    await eventually(() => client!.getStatus().state === "stale");
    assert.equal(displays.at(-1), 5);
    for (const host of hosts) await host.f.subscriptions.push!.updateBadge(host.binding.subscriptionId, { count: 0, revision: 4 });
    offline = false;
    await eventually(() => client!.getStatus().state === "ready" && client!.getStatus().count === 0, 10_000);
    assert.equal((await (await phoneRead()).json()).count, 0);
    backendOffline = true;
    // Gateway and consumer share the same elapsed time; only the authorization Backends are unavailable.
    clock += 245_000;
    clientTimeOffset = clock - Date.now();
    await eventually(() => deniedRenewals >= 3);
    const renewalBaseline = deniedRenewals;
    await pause(7_000);
    assert.ok(deniedRenewals - renewalBaseline <= 6, "failed renewal backs off independently of successful gateway reads");
    assert.equal(client.getStatus().state, "ready");
    backendOffline = false;
    holdResponse = true;
    await eventually(() => releaseResponse !== undefined);
    client.setConnections([]);
    releaseResponse!();
    await pause(100);
    assert.equal(client.getStatus().count, null);
    assert.equal(displays.at(-1), null);
    console.log("PASS desktop transport: 60s single-gateway cadence, 0 per-backend count polls, offline retention, recovery, renewal backoff, logout discards late response and zero");

    await verifyUnreadSessions(first, phoneRead);

    access = await authorize();
    const senderState = first.gatewayStore.snapshot().senders;
    first.gatewayStore.update((data) => {
      for (const sender of Object.values(data.senders)) if (sender.hostId === h.f.monitor.snapshot().hostId) sender.revoked = true;
    });
    assert.equal((await read()).status, 410);
    first.gatewayStore.update((data) => { data.senders = senderState; });
    await first.gatewayRequest("/v1/subscriptions/" + h.binding.subscriptionId, undefined, "DELETE", h.binding.revokeToken!);
    assert.equal((await read()).status, 410);
    await h.f.auth.logoutSession(h.desktop.accessToken);
    assert.equal((await h.f.request(targetsPath, h.desktop.accessToken)).status, 401);
    console.log("PASS reader revocation and desktop logout");
  } finally {
    client?.dispose();
    for (const f of fixtures.reverse()) await f.dispose();
  }
}
