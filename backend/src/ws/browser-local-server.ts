import type { IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import { LOCAL_BROWSER_MAX_FRAME } from "@runweave/shared/browser-local-tunnel";
import type { AuthService } from "../auth/service";
import type { LocalBrowserService } from "../browser-local/service";
import type { HttpUpgradeRouter } from "../server/http-upgrade-router";
import {
  isTunnelRequestAuthorized,
  rejectUnauthorizedTunnelUpgrade,
  type TunnelAuthConfig,
} from "../server/tunnel-auth";

export function localBrowserAuth(
  request: IncomingMessage,
  auth: AuthService,
): string | null {
  // A website or a ticket in the URL must never turn this into a browser-accessible proxy.
  if (
    request.headers.origin ||
    new URL(request.url ?? "/", "http://localhost").search
  )
    return null;
  const bearer = /^Bearer (\S+)$/.exec(
    request.headers.authorization ?? "",
  )?.[1];
  const session = bearer ? auth.verifyAccessToken(bearer) : null;
  return session && auth.getActiveAppSession(session.sessionId)
    ? session.sessionId
    : null;
}

export function attachLocalBrowserWebSocketServer(
  router: HttpUpgradeRouter,
  service: LocalBrowserService,
  auth: AuthService,
  tunnelAuthConfig: TunnelAuthConfig | null,
): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LOCAL_BROWSER_MAX_FRAME,
    perMessageDeflate: false,
  });
  router.register((request, socket, head) => {
    if (
      new URL(request.url ?? "/", "http://localhost").pathname !==
      "/ws/browser-local"
    )
      return false;
    const authId = localBrowserAuth(request, auth);
    if (
      !authId ||
      !isTunnelRequestAuthorized(request, tunnelAuthConfig) ||
      !service.enabled
    ) {
      rejectUnauthorizedTunnelUpgrade(socket);
      return true;
    }
    wss.handleUpgrade(request, socket, head, (ws) =>
      service.accept(ws, authId),
    );
    return true;
  });
  return wss;
}
