import type { Server as HttpServer } from "node:http";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type { AuthService } from "../auth/service";
import type { SessionManager } from "../session/manager";
import { validateWebSocketHandshake } from "./handshake";
import { resolvePageByTargetId } from "./tab-target";

interface AttachDevtoolsProxyServerOptions {
  enabled: boolean;
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

async function resolveTargetId(params: {
  sessionManager: SessionManager;
  sessionId: string;
  tabId: string;
}): Promise<string | null> {
  const { sessionManager, sessionId, tabId } = params;
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    return null;
  }

  const page = await resolvePageByTargetId(
    session.browserSession.context,
    tabId,
  );
  if (!page) {
    return null;
  }

  return tabId;
}

export function attachDevtoolsProxyServer(
  server: HttpServer,
  sessionManager: SessionManager,
  authService: AuthService,
  options: AttachDevtoolsProxyServerOptions,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws/devtools-proxy") {
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (clientSocket, request) => {
    if (!options.enabled) {
      closeWithReason(clientSocket, 1011, "DevTools proxy disabled");
      return;
    }

    const handshake = validateWebSocketHandshake({
      request,
      authService,
      sessionManager,
      requireTabId: true,
      tokenType: "devtools",
    });

    if (!handshake.ok) {
      closeWithReason(clientSocket, 1008, handshake.closeReason);
      return;
    }

    const { sessionId, tabId } = handshake;
    if (!tabId) {
      closeWithReason(clientSocket, 1008, "Missing tabId");
      return;
    }

    void (async () => {
      const remoteDebuggingPort =
        sessionManager.getRemoteDebuggingPort(sessionId);
      if (remoteDebuggingPort == null) {
        closeWithReason(clientSocket, 1011, "Remote debugging is unavailable");
        return;
      }

      const targetId = await resolveTargetId({
        sessionManager,
        sessionId,
        tabId,
      });
      if (!targetId) {
        closeWithReason(clientSocket, 1008, "Target not found");
        return;
      }

      const upstreamUrl = `ws://127.0.0.1:${remoteDebuggingPort}/devtools/page/${encodeURIComponent(targetId)}`;
      const upstreamSocket = new WebSocket(upstreamUrl);

      const closeBoth = (code: number, reason: string): void => {
        closeWithReason(clientSocket, code, reason);
        closeWithReason(upstreamSocket, code, reason);
      };

      const pendingClientMessages: Array<{ data: RawData; isBinary: boolean }> =
        [];

      clientSocket.on("message", (data, isBinary) => {
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

      clientSocket.on("close", (code, reason) => {
        closeWithReason(upstreamSocket, code, String(reason));
      });

      upstreamSocket.on("close", (code, reason) => {
        closeWithReason(clientSocket, code, String(reason));
      });

      clientSocket.on("error", (error) => {
        console.error("[viewer-be] devtools proxy client error", {
          sessionId,
          tabId,
          error: String(error),
        });
        closeBoth(1011, "Client socket error");
      });

      upstreamSocket.on("error", (error) => {
        console.error("[viewer-be] devtools proxy upstream error", {
          sessionId,
          tabId,
          error: String(error),
        });
        closeBoth(1011, "Upstream socket error");
      });
    })().catch((error) => {
      console.error("[viewer-be] devtools proxy setup failed", {
        error: String(error),
      });
      closeWithReason(clientSocket, 1011, "DevTools proxy setup failed");
    });
  });

  return wss;
}
