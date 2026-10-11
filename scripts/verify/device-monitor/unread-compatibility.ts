import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GatewayStore } from "../../../packages/push-gateway/src/store";
import { createGateway } from "../../../packages/push-gateway/src/app";
import { close, listen } from "./fixture";

/** Run the pre-change gateway entry from Git against an isolated SQLite copy, then round-trip the new version. */
export async function verifyUnreadCompatibility(directory: string, snapshot: ReturnType<GatewayStore["snapshot"]>, subscriptionId: string, credential: string) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const previous = path.join(directory, "previous-source");
  await mkdir(previous);
  await symlink(path.join(root, "packages/push-gateway/node_modules"), path.join(previous, "node_modules"));
  await writeFile(path.join(previous, "package.json"), '{"type":"module"}');
  const prefix = "packages/push-gateway/src/";
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD", prefix], { cwd: root, encoding: "utf8" }).trim().split("\n");
  for (const file of files.filter((file) => file.endsWith(".ts"))) {
    const destination = path.join(previous, file.slice(prefix.length));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, execFileSync("git", ["show", "HEAD:" + file], { cwd: root }));
  }
  const { GatewayStore: PreviousStore } = await import(pathToFileURL(path.join(previous, "store.ts")).href) as { GatewayStore: typeof GatewayStore };
  const { createGateway: previousGateway } = await import(pathToFileURL(path.join(previous, "app.ts")).href) as { createGateway: typeof createGateway };
  const state = path.join(directory, "compatibility-state");
  let store = new PreviousStore(state);
  const seed = structuredClone(snapshot);
  delete seed.badgeReaders;
  store.update((data) => Object.assign(data, seed));
  let server = previousGateway(store, async () => ({ state: "accepted" }));
  let port = await listen(server);
  const request = (route: string, method = "GET", body?: unknown) => fetch("http://localhost:" + port + route, {
    method, headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const before = await (await request("/v1/badges/" + subscriptionId)).json();
    assert.equal(before.count, 5);
    await server.disposeBadges(); await close(server); store.close();
    store = new GatewayStore(state);
    server = createGateway(store, async () => ({ state: "accepted" }));
    port = await listen(server);
    assert.deepEqual(await (await request("/v1/badges/" + subscriptionId)).json(), before);
    const readerId = randomUUID();
    assert.equal((await request("/v1/badge-readers/" + readerId, "PUT", { subscriptionId })).status, 200);
    assert.equal((await request("/v1/badges/" + subscriptionId, "PUT", { revision: 50, count: 2 })).status, 204);
    const notification = () => request("/v1/notifications", "POST", {
      subscriptionId, eventId: randomUUID(), category: "terminal.unread", title: "Compatibility", body: "Isolated fixture", occurredAt: new Date().toISOString(),
    });
    assert.equal((await (await notification()).json()).state, "accepted");
    const updated = await (await request("/v1/badges/" + subscriptionId)).json();
    assert.equal(updated.count, 6);
    await server.disposeBadges(); await close(server); store.close();
    store = new PreviousStore(state);
    server = previousGateway(store, async () => ({ state: "accepted" }));
    port = await listen(server);
    assert.deepEqual(await (await request("/v1/badges/" + subscriptionId)).json(), updated);
    assert.ok(store.snapshot().badgeReaders?.[readerId]);
    assert.equal(Object.keys(store.snapshot().subscriptions).length, Object.keys(seed.subscriptions).length);
    assert.equal((await request("/v1/badges/" + subscriptionId, "PUT", { revision: 51, count: 1 })).status, 204);
    assert.equal((await (await request("/v1/badges/" + subscriptionId)).json()).count, 5);
    assert.equal((await (await notification()).json()).state, "accepted");
    console.log("PASS gateway version round-trip: pre-change entry -> new readers -> pre-change entry; SQLite, mobile GET/PUT and notifications preserved");
  } finally { await server.disposeBadges(); await close(server); store.close(); }
}
