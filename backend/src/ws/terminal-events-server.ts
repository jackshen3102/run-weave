import type { DeviceMonitorService } from "../device-monitor/service";
import type { TerminalEventServerMessage } from "@runweave/shared/terminal/events";
import { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import type { AuthService } from "../auth/service";
import { logger } from "../logging/index";
import {
  isTunnelRequestAuthorized,
  rejectUnauthorizedTunnelUpgrade,
  type TunnelAuthConfig,
} from "../server/tunnel-auth";
import type { TerminalEventService } from "../terminal/state/terminal-event-service";
import { createHeartbeatController } from "./heartbeat";
import { validateTerminalEventsWebSocketHandshake } from "./terminal-events-handshake";
import type { HttpUpgradeRouter } from "../server/http-upgrade-router";

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
  upgradeRouter: HttpUpgradeRouter,
  authService: AuthService,
  terminalEventService: TerminalEventService,
  options?: {
    tunnelAuthConfig?: TunnelAuthConfig | null;
    deviceMonitor?: DeviceMonitorService | null;
  },
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  upgradeRouter.register((request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws/terminal-events") {
      return false;
    }
    if (!isTunnelRequestAuthorized(request, options?.tunnelAuthConfig)) {
      rejectUnauthorizedTunnelUpgrade(socket);
      return true;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
    return true;
  });

  wss.on("connection", (socket, request) => {
    const connectedAt = Date.now();
    const clientId = randomUUID();
    // Correlation headers are untrusted and intentionally limited to identifiers.
    const identifier = (name: string) => {
      const value = request.headers[name];
      return typeof value === "string" && /^[a-zA-Z0-9:_-]{1,160}$/.test(value)
        ? value
        : undefined;
    };
    const correlation = {
      clientId,
      connectionId: identifier("x-connection-id"),
      attemptId: identifier("x-connection-attempt-id"),
    };
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
      ...correlation,
      message: "Terminal events websocket connected",
      acceptedAfter: handshake.after,
      streamId: terminalEventService.getStreamId(),
    });
    const heartbeatState = {
      heartbeatTimer: null as NodeJS.Timeout | null,
      isAlive: true,
    };
    const heartbeat = createHeartbeatController(socket, heartbeatState, () => {
      terminalEventsWsLogger.warn("terminal-events-ws.heartbeat.timeout", {
        ...correlation,
        durationMs: Date.now() - connectedAt,
      });
    });
    socket.on("pong", () => heartbeat.markAlive());
    heartbeat.start();

    sendTerminalEvent(socket, {
      type: "connected",
      acceptedAfter: handshake.after,
      streamId: terminalEventService.getStreamId(),
      gap: terminalEventService.getCursorGap(handshake.after),
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

    const unsubscribeDevice = handshake.deviceStatus
      ? options?.deviceMonitor?.subscribe((snapshot) => {
          if (!authService.getActiveSession(handshake.sessionId)) {
            socket.close(1008, "Unauthorized");
            return;
          }
          sendTerminalEvent(socket, { type: "device-status", snapshot });
        })
      : undefined;
    socket.on("close", (code) => {
      unsubscribeDevice?.();
      heartbeat.stop();
      unsubscribe();
      terminalEventsWsLogger.info("terminal-events-ws.disconnected", {
        ...correlation,
        code,
        durationMs: Date.now() - connectedAt,
        message: "Terminal events websocket disconnected",
        acceptedAfter: handshake.after,
      });
    });
  });

  return wss;
}
