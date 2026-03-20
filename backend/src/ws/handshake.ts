import type { IncomingMessage } from "node:http";
import type { SessionRecord, SessionManager } from "../session/manager";
import type { AuthService } from "../auth/service";

interface HandshakeSuccess {
  ok: true;
  sessionId: string;
  session: SessionRecord;
}

interface HandshakeFailure {
  ok: false;
  errorMessage: "Unauthorized" | "Missing sessionId" | "Session not found";
  closeReason: "Unauthorized" | "Missing sessionId" | "Session not found";
  logMessage:
    | "[viewer-be] websocket rejected: unauthorized"
    | "[viewer-be] websocket rejected: missing sessionId"
    | "[viewer-be] websocket rejected: session not found";
  logMeta?: Record<string, unknown>;
}

export type HandshakeResult = HandshakeSuccess | HandshakeFailure;

export function validateWebSocketHandshake(params: {
  request: IncomingMessage;
  authService: AuthService;
  sessionManager: SessionManager;
}): HandshakeResult {
  const { request, authService, sessionManager } = params;
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const sessionId = requestUrl.searchParams.get("sessionId");
  const token = requestUrl.searchParams.get("token");

  if (!token || !authService.verifyToken(token)) {
    return {
      ok: false,
      errorMessage: "Unauthorized",
      closeReason: "Unauthorized",
      logMessage: "[viewer-be] websocket rejected: unauthorized",
    };
  }

  if (!sessionId) {
    return {
      ok: false,
      errorMessage: "Missing sessionId",
      closeReason: "Missing sessionId",
      logMessage: "[viewer-be] websocket rejected: missing sessionId",
    };
  }

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    return {
      ok: false,
      errorMessage: "Session not found",
      closeReason: "Session not found",
      logMessage: "[viewer-be] websocket rejected: session not found",
      logMeta: { sessionId },
    };
  }

  return {
    ok: true,
    sessionId,
    session,
  };
}
