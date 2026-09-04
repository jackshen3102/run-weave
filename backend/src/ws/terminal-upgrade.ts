import type { WebSocketServer } from "ws";
import {
  isTunnelRequestAuthorized,
  rejectUnauthorizedTunnelUpgrade,
  type TunnelAuthConfig,
} from "../server/tunnel-auth";
import type { HttpUpgradeRouter } from "../server/http-upgrade-router";

export function attachTerminalUpgradeHandler(
  router: HttpUpgradeRouter,
  wss: WebSocketServer,
  tunnelAuthConfig?: TunnelAuthConfig | null,
): void {
  router.register((request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws/terminal") {
      return false;
    }
    if (!isTunnelRequestAuthorized(request, tunnelAuthConfig)) {
      rejectUnauthorizedTunnelUpgrade(socket);
      return true;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
    return true;
  });
}
