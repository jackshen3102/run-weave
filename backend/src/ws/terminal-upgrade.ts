import type { Server as HttpServer } from "node:http";
import type { WebSocketServer } from "ws";
import {
  isTunnelRequestAuthorized,
  rejectUnauthorizedTunnelUpgrade,
  type TunnelAuthConfig,
} from "../server/tunnel-auth";

export function attachTerminalUpgradeHandler(
  server: HttpServer,
  wss: WebSocketServer,
  tunnelAuthConfig?: TunnelAuthConfig | null,
): void {
  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws/terminal") {
      return;
    }
    if (!isTunnelRequestAuthorized(request, tunnelAuthConfig)) {
      rejectUnauthorizedTunnelUpgrade(socket);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });
}
