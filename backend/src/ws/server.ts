import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { CDPSession } from "playwright";
import type { ClientInputMessage, ServerEventMessage } from "@browser-viewer/shared";
import { z } from "zod";
import type { SessionManager } from "../session/manager";
import { applyInputToPage } from "./input";

const clientInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mouse"),
    action: z.union([z.literal("click"), z.literal("move")]),
    x: z.number(),
    y: z.number(),
    button: z.union([z.literal("left"), z.literal("middle"), z.literal("right")]).optional(),
  }),
  z.object({
    type: z.literal("keyboard"),
    key: z.string().min(1),
    modifiers: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("scroll"),
    x: z.number().optional(),
    y: z.number().optional(),
    deltaX: z.number(),
    deltaY: z.number(),
  }),
]);

function parseClientMessage(raw: string): ClientInputMessage | null {
  try {
    const parsed = clientInputSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export function attachWebSocketServer(server: HttpServer, sessionManager: SessionManager): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  const sendEvent = (socket: WebSocket, event: ServerEventMessage): void => {
    if (socket.readyState !== 1) {
      return;
    }
    socket.send(JSON.stringify(event));
  };

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

    let cdpSession: CDPSession | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let isAlive = true;

    const onScreencastFrame = (payload: { data: string; sessionId: number }): void => {
      if (socket.readyState !== 1) {
        return;
      }

      const frameBuffer = Buffer.from(payload.data, "base64");
      socket.send(frameBuffer, { binary: true });
      void cdpSession?.send("Page.screencastFrameAck", { sessionId: payload.sessionId });
    };

    const startScreencast = async (): Promise<void> => {
      cdpSession = await session.browserSession.context.newCDPSession(session.browserSession.page);
      cdpSession.on("Page.screencastFrame", onScreencastFrame);
      await cdpSession.send("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        maxWidth: 1280,
        maxHeight: 720,
      });
    };

    const stopScreencast = async (): Promise<void> => {
      if (!cdpSession) {
        return;
      }

      cdpSession.off("Page.screencastFrame", onScreencastFrame);
      await cdpSession.send("Page.stopScreencast").catch(() => undefined);
      await cdpSession.detach().catch(() => undefined);
      cdpSession = null;
    };

    const startHeartbeat = (): void => {
      heartbeatTimer = setInterval(() => {
        if (socket.readyState !== 1) {
          return;
        }

        if (!isAlive) {
          socket.terminate();
          return;
        }

        isAlive = false;
        socket.ping();
      }, 15_000);
      heartbeatTimer.unref?.();
    };

    const stopHeartbeat = (): void => {
      if (!heartbeatTimer) {
        return;
      }
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    };

    sessionManager.markConnected(sessionId, true);
    startHeartbeat();
    sendEvent(socket, { type: "connected", sessionId });
    void startScreencast().catch((error) => {
      sendEvent(socket, { type: "error", message: String(error) });
      socket.close(1011, "Failed to start screencast");
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }

      const parsed = parseClientMessage(String(data));
      if (!parsed) {
        sendEvent(socket, { type: "error", message: "Invalid message" });
        return;
      }

      void applyInputToPage(session.browserSession.page, parsed)
        .then(() => {
          sendEvent(socket, { type: "ack", eventType: parsed.type });
        })
        .catch((error) => {
          sendEvent(socket, { type: "error", message: String(error) });
        });
    });

    socket.on("close", () => {
      stopHeartbeat();
      void stopScreencast();
      sessionManager.markConnected(sessionId, false);
    });

    socket.on("error", () => {
      stopHeartbeat();
      void stopScreencast();
    });

    socket.on("pong", () => {
      isAlive = true;
    });
  });

  return wss;
}
