import type http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { AppServerEventStreamMessage } from "@runweave/shared";
import { isAuthorizedWebSocketRequest } from "./auth.js";
import type { AppServerEventCenter } from "./event-center.js";
import { parseEventsQuery } from "./http-server.js";

export function attachEventStreamWebSocketServer(options: {
  server: http.Server;
  eventCenter: AppServerEventCenter;
  token: string;
}): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  options.server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/events/stream") {
      return;
    }

    if (!isAuthorizedWebSocketRequest(request, options.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws, request) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const query = parseEventsQuery({
      after: url.searchParams.get("after") ?? undefined,
      kind: url.searchParams.getAll("kind"),
      limit: url.searchParams.get("limit") ?? undefined,
    });

    if (!query.ok) {
      send(ws, { type: "error", message: query.message });
      ws.close(1008, query.message);
      return;
    }

    send(ws, { type: "connected", acceptedAfter: query.value.after });
    send(ws, {
      type: "events",
      delivery: "catchup",
      events: options.eventCenter.listAfter(query.value),
    });

    const kindFilter = new Set(query.value.kinds);
    const unsubscribe = options.eventCenter.subscribe((event) => {
      if (kindFilter.size > 0 && !kindFilter.has(event.kind)) {
        return;
      }
      send(ws, { type: "event", delivery: "live", event });
    });

    const heartbeat = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      }
    }, 30_000);

    ws.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return wss;
}

function send(ws: WebSocket, message: AppServerEventStreamMessage): void {
  if (ws.readyState !== ws.OPEN) {
    return;
  }
  ws.send(JSON.stringify(message));
}
