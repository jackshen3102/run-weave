import type { Server as HttpServer } from "node:http";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type { AuthService } from "../auth/service";
import type { SessionManager, SessionRecord } from "../session/manager";
import type { WebSocketSessionController } from "./session-control";
import { validateWebSocketHandshake } from "./handshake";

interface AttachAiBridgeProxyServerOptions {
  aiBridgeSessionController?: WebSocketSessionController;
  resolveBrowserWebSocketUrl?: (session: SessionRecord) => Promise<string | null>;
}

function closeWithReason(
  socket: WebSocket,
  code: number,
  reason: string,
): void {
  if (
    socket.readyState !== WebSocket.OPEN &&
    socket.readyState !== WebSocket.CONNECTING
  ) {
    return;
  }

  const canSendCloseCode =
    code === 1000 ||
    code === 1001 ||
    code === 1002 ||
    code === 1003 ||
    code === 1007 ||
    code === 1008 ||
    code === 1009 ||
    code === 1010 ||
    code === 1011 ||
    code === 1012 ||
    code === 1013 ||
    code === 1014 ||
    (code >= 3000 && code <= 4999);
  if (!canSendCloseCode) {
    socket.close();
    return;
  }

  socket.close(code, reason);
}

async function resolveBrowserWsFromHttpEndpoint(
  endpoint: string,
): Promise<string | null> {
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, "")}/json/version`);
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as {
      webSocketDebuggerUrl?: unknown;
    };
    return typeof payload.webSocketDebuggerUrl === "string"
      ? payload.webSocketDebuggerUrl
      : null;
  } catch {
    return null;
  }
}

async function defaultResolveBrowserWebSocketUrl(
  session: SessionRecord,
  sessionManager: SessionManager,
): Promise<string | null> {
  if (session.sourceType === "connect-cdp" && session.cdpEndpoint) {
    if (
      session.cdpEndpoint.startsWith("ws://") ||
      session.cdpEndpoint.startsWith("wss://")
    ) {
      return session.cdpEndpoint;
    }

    return resolveBrowserWsFromHttpEndpoint(session.cdpEndpoint);
  }

  const remoteDebuggingPort = sessionManager.getRemoteDebuggingPort(session.id);
  if (remoteDebuggingPort == null) {
    return null;
  }

  return resolveBrowserWsFromHttpEndpoint(
    `http://127.0.0.1:${remoteDebuggingPort}`,
  );
}

function inferCdpMethod(data: RawData): string | null {
  try {
    const parsed = JSON.parse(String(data)) as { method?: unknown };
    return typeof parsed.method === "string" ? parsed.method : null;
  } catch {
    return null;
  }
}

export function attachAiBridgeProxyServer(
  server: HttpServer,
  sessionManager: SessionManager,
  authService: AuthService,
  options?: AttachAiBridgeProxyServerOptions,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws/ai-bridge") {
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (clientSocket, request) => {
    const handshake = validateWebSocketHandshake({
      request,
      authService,
      sessionManager,
      tokenType: "ai-bridge",
    });
    if (!handshake.ok) {
      closeWithReason(clientSocket, 1008, handshake.closeReason);
      return;
    }

    const { sessionId, session } = handshake;
    const aiBridgeSessionController = options?.aiBridgeSessionController;
    aiBridgeSessionController?.register(sessionId, clientSocket);

    void (async () => {
      const resolveBrowserWebSocketUrl =
        options?.resolveBrowserWebSocketUrl ??
        ((candidate: SessionRecord) =>
          defaultResolveBrowserWebSocketUrl(candidate, sessionManager));
      const upstreamUrl = await resolveBrowserWebSocketUrl(session);
      if (!upstreamUrl) {
        closeWithReason(clientSocket, 1011, "Browser websocket is unavailable");
        return;
      }

      sessionManager.onAiBridgeConnected(sessionId);

      const upstreamSocket = new WebSocket(upstreamUrl);
      const pendingClientMessages: Array<{ data: RawData; isBinary: boolean }> =
        [];

      clientSocket.on("message", (data, isBinary) => {
        const method = isBinary ? null : inferCdpMethod(data);
        if (method) {
          sessionManager.onAiMessage(sessionId, method);
        }

        if (upstreamSocket.readyState === WebSocket.OPEN) {
          upstreamSocket.send(data, { binary: isBinary });
          return;
        }

        if (upstreamSocket.readyState === WebSocket.CONNECTING) {
          pendingClientMessages.push({ data, isBinary });
        }
      });

      upstreamSocket.on("open", () => {
        for (const message of pendingClientMessages) {
          upstreamSocket.send(message.data, { binary: message.isBinary });
        }
        pendingClientMessages.length = 0;
      });

      upstreamSocket.on("message", (data, isBinary) => {
        if (clientSocket.readyState !== WebSocket.OPEN) {
          return;
        }
        clientSocket.send(data, { binary: isBinary });
      });

      const resetAiStateIfLastSocket = (): void => {
        aiBridgeSessionController?.unregister(sessionId, clientSocket);
        if (
          aiBridgeSessionController &&
          aiBridgeSessionController.getSessionConnectionCount(sessionId) > 0
        ) {
          return;
        }

        sessionManager.onAiBridgeDisconnected(sessionId);
      };

      clientSocket.on("close", (code, reason) => {
        resetAiStateIfLastSocket();
        closeWithReason(upstreamSocket, code, String(reason));
      });

      upstreamSocket.on("close", (code, reason) => {
        closeWithReason(clientSocket, code, String(reason));
      });

      clientSocket.on("error", (error) => {
        sessionManager.onAiBridgeError(sessionId, String(error));
        closeWithReason(upstreamSocket, 1011, "Client socket error");
      });

      upstreamSocket.on("error", (error) => {
        sessionManager.onAiBridgeError(sessionId, String(error));
        closeWithReason(clientSocket, 1011, "Upstream socket error");
      });
    })().catch((error) => {
      sessionManager.onAiBridgeError(sessionId, String(error));
      closeWithReason(clientSocket, 1011, "AI bridge setup failed");
    });
  });

  return wss;
}
