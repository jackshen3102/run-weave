import { BrowserWindow } from "electron";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  isTerminalBrowserProfileId,
  type ResolveTerminalBrowserProfileRequest,
  type TerminalBrowserProfileId,
} from "@runweave/shared/terminal-browser-profile";
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
  getTerminalBrowserOwnerWindowId,
  getScopedTargets,
  sendJson,
} from "./terminal-browser-cdp-proxy-utils.js";
import { CDP_PROXY_TRACE_ENABLED } from "./terminal-browser-cdp-proxy-logging.js";
import { getTerminalBrowserProfilePreferences } from "./terminal-browser-profile-preferences.js";
import {
  changeTerminalBrowserCdpConnectionCount,
  resolveTerminalBrowserProfile,
} from "./terminal-browser-profile-runtime.js";
import {
  TerminalBrowserError,
  toTerminalBrowserErrorPayload,
} from "./terminal-browser-errors.js";
import { restoreTerminalBrowserTabsForWindow } from "./terminal-browser-restore.js";
import { materializeTerminalBrowserProfile } from "./terminal-browser-view-lifecycle.js";
import { createTerminalBrowserTabFromProxy } from "./terminal-browser-view.js";
import { acceptAutomationAttribution } from "./terminal-browser-automation-attribution.js";
import {
  recordTerminalBrowserAutomationCommand,
  registerTerminalBrowserAutomationConnection,
  unregisterTerminalBrowserAutomationConnection,
} from "./terminal-browser-automation-runtime.js";

export type {
  CdpProxyOptions,
  CdpProxyRuntime,
} from "./terminal-browser-cdp-proxy-types.js";

const BROWSER_ID = "runweave-terminal-browser";
const MAX_CDP_CONNECTIONS = 8;
const CDP_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_RESOLVER_BODY_BYTES = 64 * 1024;

interface Scope {
  profileId: TerminalBrowserProfileId;
  groupId: string | null;
  automationToken: string | null;
}

function resolveScope(rawUrl: string, endpoint: string): Scope {
  const parsed = new URL(rawUrl, endpoint);
  const rawProfileId = parsed.searchParams.get("profileId")?.trim() || null;
  if (rawProfileId !== null && !isTerminalBrowserProfileId(rawProfileId)) {
    throw new TerminalBrowserError(
      "INVALID_BROWSER_PROFILE",
      "Unknown Terminal Browser Profile",
      { profileId: rawProfileId },
    );
  }
  const profileId =
    rawProfileId === null
      ? getTerminalBrowserProfilePreferences().defaultProfileId
      : rawProfileId;
  return {
    profileId,
    groupId: parsed.searchParams.get("groupId")?.trim() || null,
    automationToken: parsed.searchParams.get("automationToken")?.trim() || null,
  };
}

function statusForError(error: unknown): number {
  if (!(error instanceof TerminalBrowserError)) {
    return 500;
  }
  if (
    error.code === "BROWSER_PROFILE_ROUTE_CONFLICT" ||
    error.code === "AUTOMATION_PROFILE_CONFLICT" ||
    error.code === "WHISTLE_PORT_IN_USE"
  ) {
    return 409;
  }
  if (error.code.startsWith("INVALID_")) {
    return 400;
  }
  return 503;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_RESOLVER_BODY_BYTES) {
      throw new Error("Request body is too large");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJsonResponse(
  res: http.ServerResponse,
  status: number,
  value: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

export async function startCdpProxy(
  options: CdpProxyOptions,
): Promise<CdpProxyRuntime> {
  const { host, port } = options;
  const endpoint = `http://${host}:${port}`;
  const wsUrl = `ws://${host}:${port}/devtools/browser/${BROWSER_ID}`;
  const connections = new Set<CdpProxyConnectionState>();
  const buildScopedWsUrl = (scope: Scope): string => {
    const params = new URLSearchParams({ profileId: scope.profileId });
    if (scope.groupId) {
      params.set("groupId", scope.groupId);
    }
    if (scope.automationToken) {
      params.set("automationToken", scope.automationToken);
    }
    return `${wsUrl}?${params}`;
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      if (
        req.method === "POST" &&
        url === "/runweave/browser-profile/resolve"
      ) {
        try {
          const request = (await readJsonBody(
            req,
          )) as ResolveTerminalBrowserProfileRequest;
          const resolved = await resolveTerminalBrowserProfile(request);
          const windowId = getTerminalBrowserOwnerWindowId();
          const win = windowId === null ? null : BrowserWindow.fromId(windowId);
          if (win) {
            await restoreTerminalBrowserTabsForWindow(win);
            materializeTerminalBrowserProfile(win, resolved.profileId, {
              attach: false,
            });
            if (
              resolved.browserGroupId &&
              !getScopedTargets(
                resolved.profileId,
                resolved.browserGroupId,
              ).some((target) => target.windowId === win.id)
            ) {
              await createTerminalBrowserTabFromProxy(
                win.id,
                resolved.profileId,
                "about:blank",
                resolved.browserGroupId,
                { attach: false },
              );
            }
          }
          sendJsonResponse(res, 200, resolved);
        } catch (error) {
          sendJsonResponse(res, statusForError(error), {
            error: toTerminalBrowserErrorPayload(
              error,
              "INVALID_BROWSER_PROFILE",
            ),
          });
        }
        return;
      }

      let scope: Scope;
      try {
        scope = resolveScope(url, endpoint);
      } catch (error) {
        sendJsonResponse(res, statusForError(error), {
          error: toTerminalBrowserErrorPayload(
            error,
            "INVALID_BROWSER_PROFILE",
          ),
        });
        return;
      }

      if (url.startsWith("/json/version")) {
        sendJsonResponse(
          res,
          200,
          buildVersionResponse(buildScopedWsUrl(scope), options.identity),
        );
        return;
      }
      if (/^\/json(?:\/list)?\/?(?:\?|$)/.test(url)) {
        const targets = getScopedTargets(scope.profileId, scope.groupId);
        sendJsonResponse(
          res,
          200,
          buildJsonTargetList(targets, buildScopedWsUrl(scope)),
        );
        return;
      }
      if (url.startsWith("/json/protocol")) {
        sendJsonResponse(res, 200, { version: { major: "1", minor: "3" } });
        return;
      }
      res.writeHead(404);
      res.end("Not Found");
    })().catch((error) => {
      if (!res.headersSent) {
        sendJsonResponse(res, 500, {
          error: toTerminalBrowserErrorPayload(error, "WHISTLE_START_FAILED"),
        });
      } else {
        res.destroy(error instanceof Error ? error : undefined);
      }
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const pathname = req.url ?? "";
    if (!pathname.startsWith("/devtools/browser/")) {
      socket.destroy();
      return;
    }
    try {
      resolveScope(pathname, endpoint);
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
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
  });

  wss.on("connection", (ws: WebSocket, req) => {
    const scope = resolveScope(req.url ?? "", endpoint);
    const connectionId = randomUUID();
    const windowId =
      getScopedTargets(scope.profileId, scope.groupId)[0]?.windowId ??
      getTerminalBrowserOwnerWindowId();
    if (windowId === null) {
      ws.close(1011, "No Electron window available");
      return;
    }
    let actor;
    try {
      actor = acceptAutomationAttribution({
        token: scope.automationToken,
        connectionId,
        profileId: scope.profileId,
        browserGroupId: scope.groupId,
      });
    } catch (error) {
      ws.close(
        1008,
        toTerminalBrowserErrorPayload(error, "AUTOMATION_PROFILE_CONFLICT")
          .message,
      );
      return;
    }
    const sessionManager = new CdpSessionManager((targetId, method, params) => {
      recordTerminalBrowserAutomationCommand(
        connectionId,
        targetId,
        method,
        params,
      );
    });
    const conn: CdpProxyConnectionState = {
      connectionId,
      ws,
      sessionManager,
      scopedProfileId: scope.profileId,
      scopedGroupId: scope.groupId,
      browserSessionIds: new Set(),
      discoveryEnabled: false,
      autoAttachEnabled: false,
      waitForDebuggerOnStart: false,
      isAlive: true,
    };
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      sessionManager.cleanup();
      connections.delete(conn);
      unregisterTerminalBrowserAutomationConnection(connectionId);
      changeTerminalBrowserCdpConnectionCount(scope.profileId, -1);
    };
    connections.add(conn);
    registerTerminalBrowserAutomationConnection({
      connectionId,
      actor,
      profileId: scope.profileId,
      browserGroupId: scope.groupId,
      windowId,
      state: conn,
    });
    changeTerminalBrowserCdpConnectionCount(scope.profileId, 1);
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
      if (typeof id !== "number" || typeof method !== "string") return;
      if (CDP_PROXY_TRACE_ENABLED) {
        console.info("[cdp-proxy] <<", {
          id,
          method,
          sessionId: sessionId ?? null,
        });
      }
      const safeParams = params ?? {};
      void handleMessage(connections, conn, id, method, safeParams, sessionId);
    });
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });

  const heartbeatTimer = setInterval(() => {
    for (const conn of connections) {
      if (!conn.isAlive) {
        conn.ws.terminate();
        continue;
      }
      conn.isAlive = false;
      try {
        conn.ws.ping();
      } catch {
        // The socket's close/error handlers own cleanup.
      }
    }
  }, CDP_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  const onTabClosed = ({
    targetId,
    profileId,
    browserGroupId,
  }: {
    targetId: string;
    profileId: TerminalBrowserProfileId;
    browserGroupId: string;
  }): void => {
    for (const conn of connections) {
      if (
        conn.scopedProfileId !== profileId ||
        (conn.scopedGroupId && conn.scopedGroupId !== browserGroupId)
      ) {
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
