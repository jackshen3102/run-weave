import type { IncomingMessage } from "node:http";
import type { AuthService } from "../auth/service";
import type { TerminalSessionManager } from "../terminal/manager";

interface HandshakeSuccess {
  ok: true;
  terminalSessionId: string;
}

interface HandshakeFailure {
  ok: false;
  errorMessage: "Unauthorized" | "Missing terminalSessionId" | "Terminal session not found";
  closeReason: "Unauthorized" | "Missing terminalSessionId" | "Terminal session not found";
}

export type TerminalHandshakeResult = HandshakeSuccess | HandshakeFailure;

export function validateTerminalWebSocketHandshake(params: {
  request: IncomingMessage;
  authService: AuthService;
  terminalSessionManager: TerminalSessionManager;
}): TerminalHandshakeResult {
  const { request, authService, terminalSessionManager } = params;
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const terminalSessionId = requestUrl.searchParams.get("terminalSessionId");
  const token = requestUrl.searchParams.get("token");

  if (!token || !authService.verifyToken(token)) {
    return {
      ok: false,
      errorMessage: "Unauthorized",
      closeReason: "Unauthorized",
    };
  }

  if (!terminalSessionId) {
    return {
      ok: false,
      errorMessage: "Missing terminalSessionId",
      closeReason: "Missing terminalSessionId",
    };
  }

  if (!terminalSessionManager.getSession(terminalSessionId)) {
    return {
      ok: false,
      errorMessage: "Terminal session not found",
      closeReason: "Terminal session not found",
    };
  }

  return {
    ok: true,
    terminalSessionId,
  };
}
