import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { APNsTransport } from "./apns";
import {
  bearer,
  equalSecret,
  RequestError,
  requireValue,
  senderFor,
} from "./auth";
import { deliver } from "./delivery";
import type { GatewayStore } from "./store";
import { register, revoke } from "./subscriptions";

async function readBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    requireValue(size <= 8192, 413, "Request too large");
    parts.push(part);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new RequestError(400, "Invalid JSON");
  }
  requireValue(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function reply(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}
export function createGateway(
  store: GatewayStore,
  transport: APNsTransport,
  adminToken?: string,
) {
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && path === "/health") {
        reply(res, 200, { ok: true });
        return;
      }
      const token = bearer(req);
      if (path === "/admin/status" && req.method === "GET") {
        requireValue(adminToken && equalSecret(token, adminToken), 401);
        const data = store.snapshot();
        const states: Record<string, number> = {};
        for (const d of Object.values(data.deliveries))
          states[d.state] = (states[d.state] ?? 0) + 1;
        reply(res, 200, {
          hosts: Object.values(data.senders).filter((s) => !s.revoked).length,
          subscriptions: Object.values(data.subscriptions).filter(
            (s) => !s.revoked,
          ).length,
          states,
        });
        return;
      }
      const sender = senderFor(store, token);
      if (path === "/v1/sender" && req.method === "GET") {
        requireValue(sender, 401);
        reply(res, 200, {
          hostId: sender.hostId,
          environments: sender.environments,
        });
        return;
      }
      const completedCycle =
        /^\/v1\/cycles\/([a-zA-Z0-9_-]{8,128})\/complete$/.exec(path)?.[1];
      if (completedCycle && req.method === "POST") {
        requireValue(sender, 401);
        store.update((data) => {
          const key = `${sender.hostId}:${completedCycle}`;
          (data.completedCycles ??= {})[key] ??= Date.now();
          for (const [id, delivery] of Object.entries(data.deliveries)) {
            const endedAt =
              data.completedCycles[`${delivery.hostId}:${delivery.cycleId}`];
            if (endedAt && Date.now() - endedAt > 7 * 24 * 3600_000)
              delete data.deliveries[id];
          }
        });
        reply(res, 204);
        return;
      }
      const subscription = /^\/v1\/subscriptions\/([a-zA-Z0-9_-]{8,128})$/.exec(
        path,
      )?.[1];
      if (subscription && req.method === "DELETE") {
        revoke(store, sender, subscription, token);
        reply(res, 204);
        return;
      }
      requireValue(sender, 401, "Unauthorized");
      if (subscription && req.method === "PUT") {
        reply(
          res,
          200,
          register(store, sender, subscription, await readBody(req)),
        );
        return;
      }
      if (path === "/v1/battery-alerts" && req.method === "POST") {
        reply(
          res,
          200,
          await deliver(store, sender, await readBody(req), transport),
        );
        return;
      }
      reply(res, 404, { message: "Not found" });
    })().catch((error) => {
      if (!res.headersSent)
        reply(res, error instanceof RequestError ? error.status : 503, {
          message:
            error instanceof RequestError
              ? error.message
              : "Push temporarily unavailable",
        });
      else res.destroy();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
