import { buildHealthPayload } from "../server/health";
import { Router, type Express, type RequestHandler } from "express";
import { z } from "zod";
import { readBearerToken } from "../auth/middleware";
import type { AuthService } from "../auth/service";
import type { ConnectionIdentityService } from "../auth/connection-identity";

const probe = z.object({ version: z.literal(1), nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
  .refine((value) => Buffer.from(value, "base64url").toString("base64url") === value) }).strict();

export function createConnectionIdentityRouter(service: ConnectionIdentityService, auth: AuthService): Router {
  const router = Router();
  const limits = new Map<string, { expires: number; count: number }>();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/identity", (req, res) => {
    const token = readBearerToken(req);
    if (!token || !auth.verifyAccessToken(token)) {
      res.status(401).json({ code: "CONNECTION_IDENTITY_AUTH_REQUIRED" });
      return;
    }
    const identity = service.identity();
    if (!identity) { res.status(503).json({ code: "CONNECTION_IDENTITY_UNAVAILABLE" }); return; }
    res.json(identity);
  });
  router.post("/probe", (req, res) => {
    const now = Date.now();
    for (const [key, value] of limits) if (value.expires <= now) limits.delete(key);
    const ip = req.socket.remoteAddress ?? "unknown";
    let limit = limits.get(ip);
    if (!limit) {
      if (limits.size >= 4096) { res.status(429).json({ code: "CONNECTION_PROBE_RATE_LIMITED" }); return; }
      limit = { expires: now + 60_000, count: 0 };
      limits.set(ip, limit);
    }
    if (++limit.count > 120) {
      res.set("Retry-After", String(Math.ceil((limit.expires - now) / 1000)));
      res.status(429).json({ code: "CONNECTION_PROBE_RATE_LIMITED" });
      return;
    }
    const parsed = probe.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ code: "CONNECTION_PROBE_INVALID_REQUEST" }); return; }
    const proof = service.prove(parsed.data.nonce);
    if (!proof) { res.status(503).json({ code: "CONNECTION_IDENTITY_UNAVAILABLE" }); return; }
    res.json(proof);
  });
  return router;
}

export function registerConnectionRoutes(app: Express, service: ConnectionIdentityService,
  auth: AuthService, tunnelAuth: RequestHandler, backendIdentity?: { backendId: string }): void {
  app.use("/api/connection", tunnelAuth, createConnectionIdentityRouter(service, auth));
  app.get("/health", tunnelAuth, (_req, res) => {
    res.json(buildHealthPayload(process.env, backendIdentity));
  });
}
