import type { Server as HttpServer } from "node:http";
import type { TerminalEventServerMessage } from "@browser-viewer/shared";
import { WebSocket, WebSocketServer } from "ws";
import type { AuthService } from "../auth/service";
import { logger } from "../logging";
import {
  isTunnelRequestAuthorized,
  rejectUnauthorizedTunnelUpgrade,
  type TunnelAuthConfig,
} from "../server/tunnel-auth";
import type { TerminalEventService } from "../terminal/terminal-event-service";
import { createHeartbeatController } from "./heartbeat";
import { validateTerminalEventsWebSocketHandshake } from "./terminal-events-handshake";

const terminalEventsWsLogger = logger.child({
  component: "terminal-events-ws",
});

function sendTerminalEvent(
  socket: WebSocket,
  event: TerminalEventServerMessage,
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(event));
}

export function attachTerminalEventsWebSocketServer(
  server: HttpServer,
  authService: AuthService,
  terminalEventService: TerminalEventService,
  options?: {
    tunnelAuthConfig?: TunnelAuthConfig | null;
  },
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws/terminal-events") {
      return;
    }
    if (!isTunnelRequestAuthorized(request, options?.tunnelAuthConfig)) {
      rejectUnauthorizedTunnelUpgrade(socket);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (socket, request) => {
    const handshake = validateTerminalEventsWebSocketHandshake({
      request,
      authService,
    });
    if (!handshake.ok) {
      terminalEventsWsLogger.warn("terminal-events-ws.handshake.rejected", {
        message: "Terminal events websocket handshake rejected",
        reason: handshake.closeReason,
      });
      sendTerminalEvent(socket, {
        type: "error",
        message: handshake.errorMessage,
      });
      socket.close(1008, handshake.closeReason);
      return;
    }

    terminalEventsWsLogger.info("terminal-events-ws.connected", {
      message: "Terminal events websocket connected",
      acceptedAfter: handshake.after,
    });
    const heartbeatState = {
      heartbeatTimer: null as NodeJS.Timeout | null,
      isAlive: true,
    };
    const heartbeat = createHeartbeatController(socket, heartbeatState);
    socket.on("pong", () => heartbeat.markAlive());
    heartbeat.start();

    sendTerminalEvent(socket, {
      type: "connected",
      acceptedAfter: handshake.after,
    });

    const unsubscribe = terminalEventService.subscribe((event) => {
      sendTerminalEvent(socket, {
        type: "terminal-event",
        delivery: "live",
        event,
      });
    });

    sendTerminalEvent(socket, {
      type: "terminal-events",
      delivery: "catchup",
      events: terminalEventService.listAfter(handshake.after),
    });

    socket.on("close", () => {
      heartbeat.stop();
      unsubscribe();
      terminalEventsWsLogger.info("terminal-events-ws.disconnected", {
        message: "Terminal events websocket disconnected",
        acceptedAfter: handshake.after,
      });
    });
  });

  return wss;
}
