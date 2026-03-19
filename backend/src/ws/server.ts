import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { CDPSession } from "playwright";
import type {
  ClientInputMessage,
  ServerEventMessage,
} from "@browser-viewer/shared";
import { z } from "zod";
import type { SessionManager } from "../session/manager";
import { applyInputToPage } from "./input";

const clientInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mouse"),
    action: z.union([z.literal("click"), z.literal("move")]),
    x: z.number(),
    y: z.number(),
    button: z
      .union([z.literal("left"), z.literal("middle"), z.literal("right")])
      .optional(),
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

export function attachWebSocketServer(
  server: HttpServer,
  sessionManager: SessionManager,
): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });
  let sampledMoveCount = 0;

  const sendEvent = (socket: WebSocket, event: ServerEventMessage): void => {
    if (socket.readyState !== 1) {
      return;
    }
    socket.send(JSON.stringify(event));
  };

  wss.on("connection", (socket, request) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const sessionId = requestUrl.searchParams.get("sessionId");
    console.log("[viewer-be] websocket connection incoming", {
      url: request.url,
      sessionId,
    });

    if (!sessionId) {
      console.log("[viewer-be] websocket rejected: missing sessionId");
      socket.close(1008, "Missing sessionId");
      return;
    }

    const session = sessionManager.getSession(sessionId);
    if (!session) {
      console.log("[viewer-be] websocket rejected: session not found", {
        sessionId,
      });
      socket.close(1008, "Session not found");
      return;
    }

    let cdpSession: CDPSession | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let isAlive = true;

    const onScreencastFrame = (payload: {
      data: string;
      sessionId: number;
    }): void => {
      if (socket.readyState !== 1) {
        return;
      }

      const frameBuffer = Buffer.from(payload.data, "base64");
      socket.send(frameBuffer, { binary: true });
      void cdpSession?.send("Page.screencastFrameAck", {
        sessionId: payload.sessionId,
      });
    };

    const startScreencast = async (): Promise<void> => {
      cdpSession = await session.browserSession.context.newCDPSession(
        session.browserSession.page,
      );
      cdpSession.on("Page.screencastFrame", onScreencastFrame);
      await cdpSession.send("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        maxWidth: 1280,
        maxHeight: 720,
      });
      console.log("[viewer-be] screencast started", { sessionId });
    };

    const stopScreencast = async (): Promise<void> => {
      if (!cdpSession) {
        return;
      }

      cdpSession.off("Page.screencastFrame", onScreencastFrame);
      await cdpSession.send("Page.stopScreencast").catch(() => undefined);
      await cdpSession.detach().catch(() => undefined);
      cdpSession = null;
      console.log("[viewer-be] screencast stopped", { sessionId });
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
    console.log("[viewer-be] websocket connected", { sessionId });
    void startScreencast().catch((error) => {
      sendEvent(socket, { type: "error", message: String(error) });
      console.log("[viewer-be] failed to start screencast", {
        sessionId,
        error: String(error),
      });
      socket.close(1011, "Failed to start screencast");
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }

      const parsed = parseClientMessage(String(data));
      if (!parsed) {
        console.log("[viewer-be] invalid client message", {
          sessionId,
          raw: String(data),
        });
        sendEvent(socket, { type: "error", message: "Invalid message" });
        return;
      }

      if (parsed.type === "mouse" && parsed.action === "move") {
        sampledMoveCount += 1;
        if (sampledMoveCount % 30 === 0) {
          console.log("[viewer-be] input mouse move (sampled)", {
            sessionId,
            count: sampledMoveCount,
            x: parsed.x,
            y: parsed.y,
          });
        }
      } else {
        console.log("[viewer-be] input received", { sessionId, input: parsed });
      }

      void applyInputToPage(session.browserSession.page, parsed)
        .then(() => {
          console.log("[viewer-be] input applied", {
            sessionId,
            eventType: parsed.type,
          });
          sendEvent(socket, { type: "ack", eventType: parsed.type });
        })
        .catch((error) => {
          console.log("[viewer-be] input apply failed", {
            sessionId,
            eventType: parsed.type,
            error: String(error),
          });
          sendEvent(socket, { type: "error", message: String(error) });
        });
    });

    socket.on("close", () => {
      stopHeartbeat();
      void stopScreencast();
      sessionManager.markConnected(sessionId, false);
      console.log("[viewer-be] websocket closed", { sessionId });
    });

    socket.on("error", () => {
      stopHeartbeat();
      void stopScreencast();
      console.log("[viewer-be] websocket error", { sessionId });
    });

    socket.on("pong", () => {
      isAlive = true;
    });
  });

  return wss;
}
