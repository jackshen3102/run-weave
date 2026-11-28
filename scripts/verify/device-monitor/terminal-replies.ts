import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { createRequireAuth } from "../../../backend/src/auth/middleware";
import { TerminalReplyNotifications } from "../../../backend/src/device-monitor/terminal-replies";
import { registerTerminalQuestionRoutes } from "../../../backend/src/routes/terminal/questions";
import type { TerminalSessionManager } from "../../../backend/src/terminal/manager/manager";
import type { ProviderNotification } from "../../../packages/push-gateway/src/types";
import { close, eventually, fixture, listen } from "./fixture";

const requireBackend = createRequire(path.resolve("../backend/package.json"));
const express = requireBackend("express");

export async function verifyTerminalReplyNotifications() {
  const delivered: ProviderNotification[] = [];
  const f = await fixture(async () => null, async (_subscription, message) => {
    delivered.push(message);
    return { state: "accepted" };
  });
  let replies: TerminalReplyNotifications | undefined;
  let routeServer: ReturnType<typeof httpServer> | undefined;
  try {
    let sessionAlive = true;
    let panelAlive = true;
    const terminalId = "term-reply-fixture";
    const panelId = "panel-secondary";
    const sessions = {
      getSession: (id: string) => sessionAlive && id === terminalId ? { id: terminalId, alias: "Reply Fixture" } : undefined,
      getPanel: (id: string) => panelAlive && id === panelId ? { id: panelId, terminalSessionId: terminalId } : undefined,
    } as unknown as TerminalSessionManager;

    replies = new TerminalReplyNotifications(sessions, f.subscriptions);
    await replies.start();

    const app = express();
    const router = express.Router();
    registerTerminalQuestionRoutes(router, undefined, f.auth, () => replies);
    app.use("/api/terminal", createRequireAuth(f.auth), router);
    routeServer = httpServer(app);
    const routePort = await listen(routeServer);

    const owner = await f.login();
    const other = await f.login();
    const installation = randomUUID();
    const reg = await f.subscriptions.register(owner.sessionId, installation, {
      connectionId: owner.connectionId,
      kind: "terminal-reply",
      enabled: true,
      environment: "sandbox",
      deviceToken: "ab".repeat(48),
      displayName: "Reply iPhone",
    });
    await f.subscriptions.confirm(owner.sessionId, installation, reg!.subscriptionId, reg!.version);

    await replies.expectReply(terminalId, panelId, "check deployment status", owner.sessionId);
    await replies.beginTurn(terminalId, panelId, "thread-1", "codex", "check deployment status", "evt-start-1");
    await replies.complete({
      terminalSessionId: terminalId,
      panelId,
      source: "codex",
      threadId: "thread-1",
      summary: "Deployment verified and healthy.",
      completionReason: "hook_stop",
      rawHookEvent: "Stop",
    });
    await eventually(() => delivered.length === 1);
    const pushed = delivered[0]!;
    assert.equal(pushed.category, "terminal.reply");
    assert.match(pushed.notificationId, /^[0-9a-f]{64}$/);

    const query = (id: string, token?: string, installationId?: string) =>
      fetch(`http://localhost:${routePort}/api/terminal/replies/notifications/${id}`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(installationId ? { "X-Runweave-Installation-ID": installationId } : {}),
        },
      });

    assert.equal((await query("bad-id", owner.accessToken, installation)).status, 400);
    assert.equal((await query(pushed.notificationId, owner.accessToken)).status, 400);
    assert.equal((await query(pushed.notificationId, undefined, installation)).status, 401);
    assert.equal((await query(pushed.notificationId, other.accessToken, installation)).status, 404);
    assert.equal((await query(pushed.notificationId, owner.accessToken, randomUUID())).status, 404);

    const ok = await query(pushed.notificationId.toUpperCase(), owner.accessToken, installation);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { status: "available", terminalId, panelId });

    panelAlive = false;
    const panelClosed = await query(pushed.notificationId, owner.accessToken, installation);
    assert.equal(panelClosed.status, 200);
    assert.deepEqual(await panelClosed.json(), { status: "available", terminalId, panelId: null });

    sessionAlive = false;
    const terminalClosed = await query(pushed.notificationId, owner.accessToken, installation);
    assert.equal(terminalClosed.status, 200);
    assert.deepEqual(await terminalClosed.json(), { status: "closed", terminalId });

    await f.auth.logoutSession(owner.accessToken);
    assert.equal((await query(pushed.notificationId, owner.accessToken, installation)).status, 401);
    process.stdout.write("PASS terminal reply notification target resolution: deterministic gateway notificationId, installation/session ownership, panel fallback and closed terminal state\n");
  } finally {
    if (routeServer) await close(routeServer);
    await replies?.dispose();
    await f.dispose();
  }
}
