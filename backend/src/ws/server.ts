import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import type { ClientInputMessage } from "@browser-viewer/shared";
import type { SessionManager } from "../session/manager";

function parseClientMessage(raw: string): ClientInputMessage | null {
  try {
    return JSON.parse(raw) as ClientInputMessage;
  } catch {
    return null;
  }
}

export function attachWebSocketServer(server: HttpServer, sessionManager: SessionManager): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket, request) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const sessionId = requestUrl.searchParams.get("sessionId");

    if (!sessionId) {
      socket.close(1008, "Missing sessionId");
      return;
    }

    const session = sessionManager.getSession(sessionId);
    if (!session) {
      socket.close(1008, "Session not found");
      return;
    }

    sessionManager.markConnected(sessionId, true);
    socket.send(JSON.stringify({ type: "connected", sessionId }));

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }

      const parsed = parseClientMessage(String(data));
      if (!parsed) {
        socket.send(JSON.stringify({ type: "error", message: "Invalid message" }));
        return;
      }

      // Input 注入会在下一个迭代中补齐，这里先保留连接和协议骨架。
      socket.send(JSON.stringify({ type: "ack", eventType: parsed.type }));
    });

    socket.on("close", () => {
      sessionManager.markConnected(sessionId, false);
      void sessionManager.destroySession(sessionId);
    });
  });

  return wss;
}
