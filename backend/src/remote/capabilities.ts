import type { Express, RequestHandler } from "express";
import type { RemoteCapabilities } from "@runweave/shared/remote";
import { loadInstallationId } from "./installation-id";

export function registerRemoteCapabilitiesRoute(
  app: Express,
  requireTunnelAuth: RequestHandler,
  requireAuth: RequestHandler,
  browserProfileDir: string,
  backendId: string,
): void {
  app.get("/api/remote/capabilities", requireTunnelAuth, requireAuth, async (_req, res) => {
    try {
      const payload: RemoteCapabilities = {
        protocolVersion: 1,
        installationId: await loadInstallationId(browserProfileDir),
        serviceInstanceId: `backend:${backendId}`,
        capabilities: {
          terminal: true,
          files: true,
          events: true,
          workspaceServices: true,
          desktopBrowser: true,
        },
      };
      res.json(payload);
    } catch {
      res.status(503).json({ code: "REMOTE_IDENTITY_UNAVAILABLE" });
    }
  });
}
