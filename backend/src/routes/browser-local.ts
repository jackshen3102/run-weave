import { Router } from "express";
import { LOCAL_BROWSER_MAX_CONNECTIONS, LOCAL_BROWSER_MAX_FRAME } from "@runweave/shared/browser-local-tunnel";
import { localBrowserAuth } from "../ws/browser-local-server";
import { z } from "zod";
import { parseLocalBrowserTarget } from "@runweave/shared/browser-local-tunnel";
import type { AuthService } from "../auth/service";
import { readBearerToken } from "../auth/middleware";
import type { LocalBrowserService } from "../browser-local/service";

const requestSchema = z.object({
  url: z.string().max(8192),
  terminalSessionId: z.string().min(1).max(512),
  browserSessionId: z.string().uuid(),
});

export function createDesktopLocalBrowserRouter(auth: AuthService, service: LocalBrowserService) {
  const router = Router();
  router.post("/grants", (req, res) => {
    const token = readBearerToken(req);
    const owner = token ? auth.verifyAccessToken(token) : null;
    if (req.headers.origin || !owner || !auth.getActiveDesktopSession(owner.sessionId)) {
      res.sendStatus(401); return;
    }
    const parsed = requestSchema.safeParse(req.body);
    const target = parsed.success ? parseLocalBrowserTarget(parsed.data.url) : null;
    if (!parsed.success || !target) { res.sendStatus(400); return; }
    if (!service.enabled) { res.sendStatus(503); return; }
    const grant = service.issueGrant(owner.sessionId, {
      type: "open", version: 1, terminalSessionId: parsed.data.terminalSessionId,
      browserSessionId: parsed.data.browserSessionId, host: target.host, port: target.port, secure: target.secure,
    });
    if (!grant) { res.sendStatus(409); return; }
    res.setHeader("Cache-Control", "no-store");
    res.json({ grant, protocolVersion: 1 });
  });
  return router;
}

export function createLocalBrowserCapabilitiesRouter(auth: AuthService, service: LocalBrowserService) {
  const router = Router();
  router.get("/capabilities", (req, res) => {
    if (!localBrowserAuth(req, auth)) {
      res.sendStatus(401);
      return;
    }
    if (!service.enabled) {
      res.status(503).json({ code: "disabled" });
      return;
    }
    res.json({
      protocolVersion: 1,
      maxConnections: LOCAL_BROWSER_MAX_CONNECTIONS,
      maxFrameBytes: LOCAL_BROWSER_MAX_FRAME,
    });
  });
  return router;
}
