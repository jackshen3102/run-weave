import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { CdpSessionManager } from "./terminal-browser-cdp-proxy-session.js";
import {
  buildJsonTargetList,
  buildVersionResponse,
  isCdpConnectionLimitReached,
} from "./terminal-browser-cdp-proxy-handler.js";
import { terminalBrowserEvents } from "./terminal-browser-view.js";
import { handleMessage } from "./terminal-browser-cdp-proxy-messages.js";
import type {
  CdpProxyConnectionState,
  CdpProxyOptions,
  CdpProxyRuntime,
} from "./terminal-browser-cdp-proxy-types.js";
import {
  getScopedTargets,
  sendJson,
} from "./terminal-browser-cdp-proxy-utils.js";

export type {
  CdpProxyOptions,
  CdpProxyRuntime,
} from "./terminal-browser-cdp-proxy-types.js";

const BROWSER_ID = "runweave-terminal-browser";
const MAX_CDP_CONNECTIONS = 8;
const CDP_HEARTBEAT_INTERVAL_MS = 30_000;

export async function startCdpProxy(
  options: CdpProxyOptions,
): Promise<CdpProxyRuntime> {
  const { host, port } = options;
  const endpoint = `http://${host}:${port}`;
  const wsUrl = `ws://${host}:${port}/devtools/browser/${BROWSER_ID}`;

  const connections = new Set<CdpProxyConnectionState>();
  const buildScopedWsUrl = (groupId: string | null): string => {
    if (!groupId) {
      return wsUrl;
    }
    return `${wsUrl}?groupId=${encodeURIComponent(groupId)}`;
  };
  const resolveScopedGroupId = (rawUrl: string): string | null => {
    const parsed = new URL(rawUrl, endpoint);
    return parsed.searchParams.get("groupId")?.trim() || null;
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    const scopedGroupId = resolveScopedGroupId(url);

    if (url.startsWith("/json/version")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(buildVersionResponse(buildScopedWsUrl(scopedGroupId))),
      );
      return;
    }

    if (
      url === "/json" ||
      url.startsWith("/json?") ||
      url === "/json/" ||
      url.startsWith("/json/?") ||
      url === "/json/list" ||
      url.startsWith("/json/list?") ||
      url === "/json/list/" ||
      url.startsWith("/json/list/?")
    ) {
      const targets = getScopedTargets(scopedGroupId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          buildJsonTargetList(targets, buildScopedWsUrl(scopedGroupId)),
        ),
      );
      return;
    }

    if (url.startsWith("/json/protocol")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: { major: "1", minor: "3" } }));
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const pathname = req.url ?? "";
    if (pathname.startsWith("/devtools/browser/")) {
      if (isCdpConnectionLimitReached(connections.size, MAX_CDP_CONNECTIONS)) {
        const body = `Maximum CDP connection limit (${MAX_CDP_CONNECTIONS}) reached`;
        socket.end(
          [
            "HTTP/1.1 503 Service Unavailable",
            "Connection: close",
            "Content-Type: text/plain; charset=utf-8",
            `Content-Length: ${Buffer.byteLength(body)}`,
            "",
            body,
          ].join("\r\n"),
        );
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws: WebSocket, req) => {
    const sessionManager = new CdpSessionManager();
    const conn: CdpProxyConnectionState = {
      ws,
      sessionManager,
      scopedGroupId: resolveScopedGroupId(req.url ?? ""),
      browserSessionIds: new Set(),
      discoveryEnabled: false,
      autoAttachEnabled: false,
      waitForDebuggerOnStart: false,
      isAlive: true,
    };
    connections.add(conn);

    sessionManager.setMessageRelay((data) => sendJson(ws, data));

    ws.on("pong", () => {
      conn.isAlive = true;
    });

    ws.on("message", (raw) => {
      let msg: {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      const { id, method, params, sessionId } = msg;
      if (typeof id !== "number" || typeof method !== "string") {
        return;
      }

      console.info("[cdp-proxy] <<", {
        id,
        method,
        sessionId: sessionId ?? null,
      });
      void handleMessage(
        connections,
        conn,
        id,
        method,
        params ?? {},
        sessionId,
      );
    });

    ws.on("close", () => {
      sessionManager.cleanup();
      connections.delete(conn);
    });

    ws.on("error", () => {
      sessionManager.cleanup();
      connections.delete(conn);
    });
  });

  const heartbeatTimer = setInterval(() => {
    for (const conn of connections) {
      if (!conn.isAlive) {
        // Missed the previous ping's pong — treat the connection as dead. The
        // resulting "close" event runs sessionManager.cleanup(), which resets
        // cdpProxyAttached on any target this client was holding.
        conn.ws.terminate();
        continue;
      }
      conn.isAlive = false;
      try {
        conn.ws.ping();
      } catch {
        // Ping on an already-broken socket will surface via "close"/"error".
      }
    }
  }, CDP_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  const onTabClosed = ({
    targetId,
    browserGroupId,
  }: {
    targetId: string;
    browserGroupId: string;
  }): void => {
    for (const conn of connections) {
      if (conn.scopedGroupId && conn.scopedGroupId !== browserGroupId) {
        continue;
      }
      const proxySessionId = conn.sessionManager.getProxySessionId(targetId);
      conn.sessionManager.detachDebugger(targetId);
      if (conn.discoveryEnabled) {
        sendJson(conn.ws, {
          method: "Target.targetDestroyed",
          params: { targetId },
        });
      }
      if (proxySessionId) {
        sendJson(conn.ws, {
          method: "Target.detachedFromTarget",
          params: { sessionId: proxySessionId, targetId },
        });
      }
    }
  };

  terminalBrowserEvents.on("tab-closed", onTabClosed);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      console.info(`[cdp-proxy] listening on ${endpoint}`);
      resolve();
    });
  });

  return {
    endpoint,
    port,
    host,
    stop: async () => {
      clearInterval(heartbeatTimer);
      terminalBrowserEvents.off("tab-closed", onTabClosed);
      for (const conn of connections) {
        conn.sessionManager.cleanup();
        conn.ws.close();
      }
      connections.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
