import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { BrowserWindow } from "electron";
import { CdpSessionManager } from "./terminal-browser-cdp-proxy-session.js";
import {
  buildVersionResponse,
  buildTargetInfo,
  buildCdpResult,
  buildCdpError,
  buildCdpSessionResult,
  buildCdpSessionError,
  isBlockedCommand,
  classifyCdpCommand,
  validateNavigateParams,
  validateSetContentParams,
  validateKeyEvent,
  resolveCreateTargetWindowId,
  isCdpConnectionLimitReached,
  shouldSendTargetCreatedEvent,
  type CdpTargetInfo,
} from "./terminal-browser-cdp-proxy-handler.js";
import {
  getTerminalBrowserCdpTargets,
  getTerminalBrowserEntryByTargetId,
  createTerminalBrowserTabFromProxy,
  closeTerminalBrowserTabFromProxy,
  activateTerminalBrowserTabFromProxy,
  terminalBrowserEvents,
} from "./terminal-browser-view.js";

const BROWSER_ID = "runweave-terminal-browser";
const MAX_AI_TABS = 10;
const MAX_CDP_CONNECTIONS = 8;

export interface CdpProxyOptions {
  host: string;
  port: number;
}

export interface CdpProxyRuntime {
  endpoint: string;
  port: number;
  host: string;
  stop(): Promise<void>;
}

interface ConnectionState {
  ws: WebSocket;
  sessionManager: CdpSessionManager;
  discoveryEnabled: boolean;
  autoAttachEnabled: boolean;
  waitForDebuggerOnStart: boolean;
}

function getFirstWindowId(): number | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0]!.id : null;
}

function sendJson(ws: WebSocket, data: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    const payload = data as Record<string, unknown>;
    console.info("[cdp-proxy] >>", {
      id: payload.id ?? null,
      method: payload.method ?? null,
      sessionId: payload.sessionId ?? null,
    });
    ws.send(JSON.stringify(data));
  }
}

function getCurrentTargetInfos(
  sessionManager: CdpSessionManager,
): CdpTargetInfo[] {
  return getTerminalBrowserCdpTargets().map((t) =>
    buildTargetInfo({
      targetId: t.targetId,
      url: t.url,
      title: t.title,
      attached: sessionManager.isTargetAttached(t.targetId),
    }),
  );
}

function getTargetInfoForRequest(
  sessionManager: CdpSessionManager,
  params: Record<string, unknown>,
  sessionId?: string,
): CdpTargetInfo | null {
  const requestedTargetId =
    typeof params.targetId === "string" ? params.targetId : null;
  const sessionTargetId = sessionId
    ? sessionManager.getTargetIdForSession(sessionId)
    : null;
  const targetId = requestedTargetId ?? sessionTargetId;
  const targets = getCurrentTargetInfos(sessionManager);

  if (targetId) {
    return targets.find((target) => target.targetId === targetId) ?? null;
  }
  return targets.find((target) => target.attached) ?? targets[0] ?? null;
}

function broadcastTargetCreated(
  connections: Set<ConnectionState>,
  initiator: ConnectionState,
  target: { targetId: string; url: string; title: string },
): void {
  for (const conn of connections) {
    if (
      !shouldSendTargetCreatedEvent(conn.discoveryEnabled, conn === initiator)
    ) {
      continue;
    }
    sendJson(conn.ws, {
      method: "Target.targetCreated",
      params: {
        targetInfo: buildTargetInfo({
          targetId: target.targetId,
          url: target.url,
          title: target.title,
          attached: false,
        }),
      },
    });
  }
}

export async function startCdpProxy(
  options: CdpProxyOptions,
): Promise<CdpProxyRuntime> {
  const { host, port } = options;
  const endpoint = `http://${host}:${port}`;
  const wsUrl = `ws://${host}:${port}/devtools/browser/${BROWSER_ID}`;

  const connections = new Set<ConnectionState>();

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";

    if (url === "/json/version" || url === "/json/version/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(buildVersionResponse(wsUrl)));
      return;
    }

    if (url === "/json/protocol" || url === "/json/protocol/") {
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

  wss.on("connection", (ws: WebSocket) => {
    const sessionManager = new CdpSessionManager();
    const conn: ConnectionState = {
      ws,
      sessionManager,
      discoveryEnabled: false,
      autoAttachEnabled: false,
      waitForDebuggerOnStart: false,
    };
    connections.add(conn);

    sessionManager.setMessageRelay((data) => sendJson(ws, data));

    ws.on("message", (raw) => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      const { id, method, params, sessionId } = msg;
      if (typeof id !== "number" || typeof method !== "string") {
        return;
      }

      console.info("[cdp-proxy] <<", { id, method, sessionId: sessionId ?? null });
      void handleMessage(connections, conn, id, method, params ?? {}, sessionId);
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

  const onTabClosed = ({ targetId }: { targetId: string }): void => {
    for (const conn of connections) {
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
          params: { sessionId: proxySessionId },
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

async function handleMessage(
  connections: Set<ConnectionState>,
  conn: ConnectionState,
  id: number,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
): Promise<void> {
  const { ws, sessionManager } = conn;

  if (sessionId) {
    await handleSessionMessage(conn, id, method, params, sessionId);
    return;
  }

  if (isBlockedCommand(method)) {
    sendJson(ws, buildCdpError(id, -32601, `${method} is blocked by CDP proxy`));
    return;
  }

  const cls = classifyCdpCommand(method);

  try {
    switch (method) {
      case "Browser.getVersion":
        sendJson(
          ws,
          buildCdpResult(id, {
            protocolVersion: "1.3",
            product: "Runweave/CDP-Proxy",
            revision: "",
            userAgent: "Runweave/CDP-Proxy",
            jsVersion: "",
          }),
        );
        return;

      case "Target.getTargets": {
        const targets = getCurrentTargetInfos(sessionManager);
        sendJson(ws, buildCdpResult(id, { targetInfos: targets }));
        return;
      }

      case "Target.getTargetInfo": {
        const targetInfo = getTargetInfoForRequest(sessionManager, params);
        if (!targetInfo) {
          sendJson(
            ws,
            buildCdpError(id, -32000, "No terminal browser target available"),
          );
          return;
        }
        sendJson(ws, buildCdpResult(id, { targetInfo }));
        return;
      }

      case "Target.setDiscoverTargets": {
        const discover = params.discover === true;
        conn.discoveryEnabled = discover;
        sendJson(ws, buildCdpResult(id, {}));

        if (discover) {
          const targets = getCurrentTargetInfos(sessionManager);
          for (const info of targets) {
            sendJson(ws, {
              method: "Target.targetCreated",
              params: { targetInfo: info },
            });
          }
        }
        return;
      }

      case "Target.setAutoAttach": {
        const autoAttach = params.autoAttach === true;
        const waitForDebuggerOnStart = params.waitForDebuggerOnStart === true;
        conn.autoAttachEnabled = autoAttach;
        conn.waitForDebuggerOnStart = waitForDebuggerOnStart;
        sendJson(ws, buildCdpResult(id, {}));

        if (autoAttach) {
          const targets = getTerminalBrowserCdpTargets();
          for (const t of targets) {
            try {
              const { proxySessionId } = sessionManager.attachDebugger(
                t.targetId,
                t.webContents,
              );
              const targetInfo = buildTargetInfo({
                targetId: t.targetId,
                url: t.url,
                title: t.title,
                attached: true,
              });
              sendJson(ws, {
                method: "Target.attachedToTarget",
                params: {
                  sessionId: proxySessionId,
                  targetInfo,
                  waitingForDebugger: waitForDebuggerOnStart,
                },
              });
            } catch (error) {
              console.warn("[cdp-proxy] auto-attach failed", {
                targetId: t.targetId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
        return;
      }

      case "Target.attachToTarget": {
        const targetId = params.targetId as string;
        if (!targetId) {
          sendJson(ws, buildCdpError(id, -32602, "targetId required"));
          return;
        }
        const found = getTerminalBrowserEntryByTargetId(targetId);
        if (!found) {
          sendJson(ws, buildCdpError(id, -32602, `Unknown target: ${targetId}`));
          return;
        }
        try {
          const target = getTerminalBrowserCdpTargets().find(
            (t) => t.targetId === targetId,
          );
          if (!target) {
            sendJson(ws, buildCdpError(id, -32602, `Target not found: ${targetId}`));
            return;
          }
          const { proxySessionId } = sessionManager.attachDebugger(
            targetId,
            target.webContents,
          );
          sendJson(ws, buildCdpResult(id, { sessionId: proxySessionId }));
        } catch (error) {
          sendJson(
            ws,
            buildCdpError(
              id,
              -32000,
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
        return;
      }

      case "Target.activateTarget": {
        const targetId = params.targetId as string;
        if (!targetId) {
          sendJson(ws, buildCdpError(id, -32602, "targetId required"));
          return;
        }
        activateTerminalBrowserTabFromProxy(targetId);
        sendJson(ws, buildCdpResult(id, {}));
        return;
      }

      case "Target.createTarget": {
        const url = (params.url as string) || "about:blank";
        const navCheck = validateNavigateParams({ url });
        if (!navCheck.ok) {
          sendJson(ws, buildCdpError(id, -32602, navCheck.error));
          return;
        }

        const currentTargets = getTerminalBrowserCdpTargets();
        if (currentTargets.length >= MAX_AI_TABS) {
          sendJson(
            ws,
            buildCdpError(id, -32000, `Maximum AI tab limit (${MAX_AI_TABS}) reached`),
          );
          return;
        }

        const windowId = resolveCreateTargetWindowId(
          currentTargets,
          sessionManager.getAttachedTargetIds(),
          getFirstWindowId(),
        );
        if (windowId === null) {
          sendJson(ws, buildCdpError(id, -32000, "No Electron window available"));
          return;
        }

        const created = await createTerminalBrowserTabFromProxy(windowId, url);
        if (!created) {
          sendJson(ws, buildCdpError(id, -32000, "Failed to create tab"));
          return;
        }

        broadcastTargetCreated(
          connections,
          conn,
          {
            targetId: created.targetId,
            url,
            title: "",
          },
        );

        if (conn.autoAttachEnabled) {
          try {
            const { proxySessionId } = sessionManager.attachDebugger(
              created.targetId,
              created.webContents,
            );
            sendJson(ws, {
              method: "Target.attachedToTarget",
              params: {
                sessionId: proxySessionId,
                targetInfo: buildTargetInfo({
                  targetId: created.targetId,
                  url,
                  title: "",
                  attached: true,
                }),
                waitingForDebugger: conn.waitForDebuggerOnStart,
              },
            });
          } catch (error) {
            console.warn("[cdp-proxy] auto-attach to new target failed", {
              targetId: created.targetId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        sendJson(ws, buildCdpResult(id, { targetId: created.targetId }));
        return;
      }

      case "Target.closeTarget": {
        const targetId = params.targetId as string;
        if (!targetId) {
          sendJson(ws, buildCdpError(id, -32602, "targetId required"));
          return;
        }
        const success = closeTerminalBrowserTabFromProxy(targetId);
        if (!success) {
          sessionManager.detachDebugger(targetId);
        }
        sendJson(ws, buildCdpResult(id, { success }));
        return;
      }

      default:
        if (cls === "session") {
          sendJson(
            ws,
            buildCdpError(id, -32601, `${method} requires a sessionId`),
          );
        } else {
          // For unhandled browser-level commands (e.g. Browser.setDownloadBehavior),
          // return an empty success so Playwright's init sequence doesn't break.
          console.info("[cdp-proxy] stub OK for unhandled browser command", { id, method });
          sendJson(ws, buildCdpResult(id, {}));
        }
        return;
    }
  } catch (error) {
    sendJson(
      ws,
      buildCdpError(
        id,
        -32000,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

/**
 * Session-level Target.* commands that must NOT be forwarded to Electron's
 * internal CDP. Forwarding Target.createTarget would create a new Electron
 * BrowserWindow; forwarding Target.setAutoAttach would expose non-terminal-
 * browser targets. We handle these locally with stub/no-op responses.
 */
const SESSION_TARGET_INTERCEPTS = new Set([
  "Target.setAutoAttach",
  "Target.getTargets",
  "Target.setDiscoverTargets",
  "Target.getTargetInfo",
  "Target.createTarget",
  "Target.closeTarget",
  "Target.activateTarget",
  "Target.attachToTarget",
  "Target.detachFromTarget",
]);

async function handleSessionMessage(
  conn: ConnectionState,
  id: number,
  method: string,
  params: Record<string, unknown>,
  sessionId: string,
): Promise<void> {
  const { ws, sessionManager } = conn;

  if (isBlockedCommand(method)) {
    sendJson(
      ws,
      buildCdpSessionError(id, sessionId, -32601, `${method} is blocked by CDP proxy`),
    );
    return;
  }

  // Intercept session-level Target.* commands — never forward these to
  // Electron's internal CDP as they would create new windows or expose
  // targets outside the Terminal Browser sandbox.
  if (method === "Target.getTargetInfo") {
    const targetInfo = getTargetInfoForRequest(sessionManager, params, sessionId);
    if (!targetInfo) {
      sendJson(
        ws,
        buildCdpSessionError(
          id,
          sessionId,
          -32000,
          "No terminal browser target available",
        ),
      );
      return;
    }
    sendJson(ws, buildCdpSessionResult(id, sessionId, { targetInfo }));
    return;
  }

  if (SESSION_TARGET_INTERCEPTS.has(method)) {
    console.info("[cdp-proxy] intercepted session-level Target command", { id, method, sessionId });
    sendJson(ws, buildCdpSessionResult(id, sessionId, {}));
    return;
  }

  if (method === "Page.navigate") {
    const navCheck = validateNavigateParams(params as { url?: string });
    if (!navCheck.ok) {
      sendJson(ws, buildCdpSessionError(id, sessionId, -32602, navCheck.error));
      return;
    }
  }

  if (method === "Page.setDocumentContent") {
    const contentCheck = validateSetContentParams(params as { html?: string });
    if (!contentCheck.ok) {
      sendJson(ws, buildCdpSessionError(id, sessionId, -32602, contentCheck.error));
      return;
    }
  }

  if (method === "Input.dispatchKeyEvent") {
    const keyCheck = validateKeyEvent(
      params as { type?: string; modifiers?: number; key?: string },
    );
    if (!keyCheck.ok) {
      sendJson(ws, buildCdpSessionError(id, sessionId, -32602, keyCheck.error));
      return;
    }
  }

  if (method === "Runtime.runIfWaitingForDebugger") {
    try {
      const result = await sessionManager.sendCommand(sessionId, method, params);
      sendJson(ws, buildCdpSessionResult(id, sessionId, result));
    } catch {
      sendJson(ws, buildCdpSessionResult(id, sessionId, {}));
    }
    return;
  }

  try {
    const result = await sessionManager.sendCommand(sessionId, method, params);
    sendJson(ws, buildCdpSessionResult(id, sessionId, result));
  } catch (error) {
    sendJson(
      ws,
      buildCdpSessionError(
        id,
        sessionId,
        -32000,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}
