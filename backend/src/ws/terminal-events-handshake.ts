import type { IncomingMessage } from "node:http";
import type { AuthService } from "../auth/service";

interface TerminalEventsHandshakeSuccess {
  ok: true;
  after: string | null;
}

interface TerminalEventsHandshakeFailure {
  ok: false;
  errorMessage: "Unauthorized" | "Missing after";
  closeReason: "Unauthorized" | "Missing after";
}

export type TerminalEventsHandshakeResult =
  | TerminalEventsHandshakeSuccess
  | TerminalEventsHandshakeFailure;

export function validateTerminalEventsWebSocketHandshake(params: {
  request: IncomingMessage;
  authService: AuthService;
}): TerminalEventsHandshakeResult {
  const requestUrl = new URL(params.request.url ?? "/", "http://localhost");
  const token = requestUrl.searchParams.get("token");

  if (!requestUrl.searchParams.has("after")) {
    return {
      ok: false,
      errorMessage: "Missing after",
      closeReason: "Missing after",
    };
  }

  const afterParam = requestUrl.searchParams.get("after");
  const after = afterParam?.trim() || null;
  const verifiedTicket =
    token &&
    params.authService.verifyTemporaryToken(token, {
      tokenType: "terminal-events-ws",
      resource: {},
    });
  if (!verifiedTicket) {
    return {
      ok: false,
      errorMessage: "Unauthorized",
      closeReason: "Unauthorized",
    };
  }

  return {
    ok: true,
    after,
  };
}
