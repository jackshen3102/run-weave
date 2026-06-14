import type { Router } from "express";
import type {
  CreateTerminalEventsWsTicketResponse,
  CreateTerminalWsTicketResponse,
} from "@runweave/shared";
import type { AuthService } from "../auth/service";
import { readBearerToken } from "../auth/middleware";
import type { TerminalSessionManager } from "../terminal/manager";
import type { TerminalEventService } from "../terminal/terminal-event-service";

type TerminalTicketRouteOptions = {
  authService?: AuthService;
  terminalEventService?: TerminalEventService;
};

function resolveAuthenticatedSessionId(
  authService: AuthService | undefined,
  authorizationHeader: string | undefined,
): string | null {
  if (!authService) {
    return null;
  }
  const token = readBearerToken({
    headers: { authorization: authorizationHeader },
  } as never);
  if (!token) {
    return null;
  }
  return authService.verifyAccessToken(token)?.sessionId ?? null;
}

export function registerTerminalTicketRoutes(
  router: Router,
  terminalSessionManager: TerminalSessionManager,
  options?: TerminalTicketRouteOptions,
): void {
  const handleTerminalEventsWsTicket = (authorizationHeader?: string) => {
    if (!options?.authService) {
      return { status: 503, payload: { message: "Terminal ticket service unavailable" } };
    }
    const authSessionId = resolveAuthenticatedSessionId(
      options.authService,
      authorizationHeader,
    );
    if (!authSessionId) {
      return { status: 401, payload: { message: "Unauthorized" } };
    }

    const issued = options.authService.issueTemporaryToken({
      sessionId: authSessionId,
      tokenType: "terminal-events-ws",
      resource: {},
      ttlMs: 60_000,
    });
    const payload: CreateTerminalEventsWsTicketResponse = {
      ticket: issued.token,
      expiresIn: issued.expiresIn,
      baselineEventId: options.terminalEventService?.getLatestId() ?? null,
    };
    return { status: 200, payload };
  };

  router.post("/events/ws-ticket", (req, res) => {
    const result = handleTerminalEventsWsTicket(req.headers.authorization);
    res.status(result.status).json(result.payload);
  });
  router.post("/completion-events/ws-ticket", (req, res) => {
    const result = handleTerminalEventsWsTicket(req.headers.authorization);
    res.status(result.status).json(result.payload);
  });

  router.post("/session/:id/ws-ticket", (req, res) => {
    const session = terminalSessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }
    if (!options?.authService) {
      res.status(503).json({ message: "Terminal ticket service unavailable" });
      return;
    }
    const authSessionId = resolveAuthenticatedSessionId(
      options.authService,
      req.headers.authorization,
    );
    if (!authSessionId) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const issued = options.authService.issueTemporaryToken({
      sessionId: authSessionId,
      tokenType: "terminal-ws",
      resource: { terminalSessionId: session.id },
      ttlMs: 60_000,
    });
    const payload: CreateTerminalWsTicketResponse = {
      ticket: issued.token,
      expiresIn: issued.expiresIn,
    };
    res.status(200).json(payload);
  });
}
