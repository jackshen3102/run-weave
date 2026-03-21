import type { IncomingMessage } from "node:http";
import type { SessionRecord, SessionManager } from "../session/manager";
import type { AuthService } from "../auth/service";

interface HandshakeSuccess {
  ok: true;
  sessionId: string;
  session: SessionRecord;
  tabId: string | null;
}

interface HandshakeFailure {
  ok: false;
  errorMessage:
    | "Unauthorized"
    | "Missing sessionId"
    | "Session not found"
    | "Missing tabId";
  closeReason:
    | "Unauthorized"
    | "Missing sessionId"
    | "Session not found"
    | "Missing tabId";
  logMessage:
    | "[viewer-be] websocket rejected: unauthorized"
    | "[viewer-be] websocket rejected: missing sessionId"
    | "[viewer-be] websocket rejected: session not found"
    | "[viewer-be] websocket rejected: missing tabId";
  logMeta?: Record<string, unknown>;
}

export type HandshakeResult = HandshakeSuccess | HandshakeFailure;

export function validateWebSocketHandshake(params: {
  request: IncomingMessage;
  authService: AuthService;
  sessionManager: SessionManager;
  requireTabId?: boolean;
}): HandshakeResult {
  const { request, authService, sessionManager, requireTabId = false } = params;
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const sessionId = requestUrl.searchParams.get("sessionId");
  const token = requestUrl.searchParams.get("token");
  const tabId = requestUrl.searchParams.get("tabId");

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

  if (requireTabId && !tabId) {
    return {
      ok: false,
      errorMessage: "Missing tabId",
      closeReason: "Missing tabId",
      logMessage: "[viewer-be] websocket rejected: missing tabId",
      logMeta: { sessionId },
    };
  }

  return {
    ok: true,
    sessionId,
    session,
    tabId,
  };
}
