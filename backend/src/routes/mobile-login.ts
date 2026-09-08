import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { normalizeMobileLoginBaseUrl } from "@runweave/shared/mobile-login";
import { readBearerToken } from "../auth/middleware";
import { MobileLoginError, type MobileLoginService } from "../auth/mobile-login";
import type { AuthService } from "../auth/service";

const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const claimant = z.object({ claimantToken: secret }).strict();
const create = z.object({
  baseUrl: z.string().refine((value) => { try { normalizeMobileLoginBaseUrl(value); return true; } catch { return false; } }),
  connectionName: z.string().trim().min(1).max(128),
}).strict();
const claim = claimant.extend({ qrSecret: secret, deviceName: z.string().trim().min(1).max(128),
  connectionId: z.string().min(1).max(256) });
const decision = z.object({ claimId: z.string().uuid(), decision: z.enum(["approve", "reject"]) }).strict();

export function createMobileLoginRouter(service: MobileLoginService, auth: AuthService): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const owner = (req: Request): string => {
    const token = readBearerToken(req);
    const session = token ? auth.verifyAccessToken(token) : null;
    if (!session) throw new MobileLoginError(401, "unauthorized");
    return session.sessionId;
  };
  const handle = (run: (req: Request, res: Response) => unknown) => async (req: Request, res: Response) => {
    try { await run(req, res); }
    catch (error) {
      if (error instanceof MobileLoginError) {
        if (error.retryAfter) res.setHeader("Retry-After", String(error.retryAfter));
        res.status(error.status).json({ code: error.code, message: error.message });
      } else if (error instanceof z.ZodError) {
        res.status(400).json({ code: "invalid_request", message: "Invalid request body" });
      } else {
        res.status(503).json({ code: "issuance_failed", message: "Mobile login unavailable" });
      }
    }
  };
  const id = (req: Request): string => z.string().uuid().parse(req.params.id);
  const limit = (req: Request): void => {
    // Socket identity cannot be spoofed with an arbitrary forwarding header.
    service.rateLimit(`ip:${req.socket.remoteAddress ?? "unknown"}`, 240);
    service.rateLimit(`request:${id(req)}`, 180);
  };
  router.post("/", handle((req, res) => { res.status(201).json(service.create(owner(req), create.parse(req.body))); }));
  router.get("/:id", handle((req, res) => { res.json(service.status(id(req), owner(req))); }));
  router.post("/:id/claim", handle((req, res) => { limit(req); res.json(service.claim(id(req), claim.parse(req.body))); }));
  router.post("/:id/decision", handle((req, res) => { res.json(service.decision(id(req), owner(req), decision.parse(req.body))); }));
  router.post("/:id/exchange", handle(async (req, res) => {
    limit(req);
    const result = await service.exchange(id(req), claimant.parse(req.body).claimantToken);
    res.status("accessToken" in result ? 200 : 202).json(result);
  }));
  router.post("/:id/complete", handle((req, res) => {
    limit(req);
    res.json(service.complete(id(req), claimant.parse(req.body).claimantToken, owner(req)));
  }));
  router.post("/:id/cancel", handle((req, res) => {
    limit(req);
    // A supplied Authorization header selects owner authentication, even if invalid.
    const proof = req.headers.authorization !== undefined
      ? (z.object({}).strict().parse(req.body ?? {}), { ownerSessionId: owner(req) })
      : claimant.parse(req.body);
    res.json(service.cancel(id(req), proof));
  }));
  return router;
}
