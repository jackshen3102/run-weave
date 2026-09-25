import type { Express, RequestHandler } from "express";
import { DesktopStateError, readDesktopNetwork } from "./read-model";
export function registerDesktopNetworkRoutes(
  app: Express,
  requireAuth: RequestHandler,
): void {
  for (const route of ["/api/tunnels", "/api/desktop-network"])
    app.get(route, requireAuth, (req, res) => {
      res.set("Cache-Control", "no-store");
      if (Object.keys(req.query).length) {
        res
          .status(400)
          .json({
            code: "DESKTOP_STATE_SCOPE_FIXED",
            message: "只能读取当前节点的桌面状态",
          });
        return;
      }
      try {
        const snapshot = readDesktopNetwork();
        res.json(route === "/api/tunnels" ? snapshot.tunnels : snapshot);
      } catch (error) {
        res.status(503).json({
          code:
            error instanceof DesktopStateError
              ? error.code
              : "DESKTOP_STATE_UNAVAILABLE",
          message: "此 Backend 没有可读取的同机桌面状态",
        });
      }
    });
}
