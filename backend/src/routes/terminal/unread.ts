import { Router } from "express";
import { z } from "zod";
import type { AuthService } from "../../auth/service";
import { readBearerToken } from "../../auth/middleware";
import type { DesktopBadgeAccess } from "../../device-monitor/desktop-badge-access";
import { SubscriptionError } from "../../device-monitor/subscriptions";
import { PushClientError } from "../../device-monitor/push-client";
import type { TerminalBadges } from "../../device-monitor/terminal-badges";

export function createTerminalUnreadRouter(
  service: TerminalBadges | null,
  desktopAccess: DesktopBadgeAccess | null = null,
  auth?: AuthService,
): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.all(["/gateway-targets", "/gateway-access"], async (req, res) => {
    try {
      const identity = auth?.verifyAccessToken(readBearerToken(req) ?? "");
      if (!identity) throw new SubscriptionError(401, "Unauthorized");
      if (!desktopAccess) throw new SubscriptionError(503, "未读同步暂不可用");
      if (req.path === "/gateway-targets" && req.method === "GET") {
        res.json(desktopAccess.targets(identity.sessionId));
      } else if (req.path === "/gateway-access" && req.method === "POST") {
        const body = z.object({ subscriptionId: z.string().uuid() }).strict().safeParse(req.body);
        if (!body.success) throw new SubscriptionError(400, "Invalid subscriptionId");
        res.json(await desktopAccess.access(identity.sessionId, body.data.subscriptionId));
      } else res.sendStatus(405);
    } catch (error) {
      res.status(error instanceof SubscriptionError || error instanceof PushClientError ? error.status : 503)
        .json({ message: error instanceof SubscriptionError ? error.message : "未读同步服务暂不可用" });
    }
  });
  router.get("/", async (_req, res, next) => {
    try {
      if (!service) { res.status(503).json({ message: "Unread count unavailable" }); return; }
      res.json(await service.snapshot());
    } catch (error) { next(error); }
  });
  return router;
}
