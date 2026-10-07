import { Router } from "express";
import type { TerminalBadges } from "../../device-monitor/terminal-badges";

export function createTerminalUnreadRouter(service: TerminalBadges | null): Router {
  const router = Router();
  router.get("/", async (_req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      if (!service) { res.status(503).json({ message: "Unread count unavailable" }); return; }
      res.json(await service.snapshot());
    } catch (error) { next(error); }
  });
  return router;
}
