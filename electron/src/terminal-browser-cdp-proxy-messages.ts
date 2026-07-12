import { randomUUID } from "node:crypto";
import {
  buildCdpError,
  buildCdpResult,
  buildTargetInfo,
  classifyCdpCommand,
  isBlockedCommand,
  resolveCreateTargetWindowId,
  validateNavigateParams,
} from "./terminal-browser-cdp-proxy-handler.js";
import {
  activateTerminalBrowserTabFromProxy,
  closeTerminalBrowserTabFromProxy,
  createTerminalBrowserTabFromProxy,
  getTerminalBrowserCdpTargets,
  getTerminalBrowserEntryByTargetId,
} from "./terminal-browser-view.js";
import type { CdpProxyConnectionState } from "./terminal-browser-cdp-proxy-types.js";
import { CDP_PROXY_TRACE_ENABLED } from "./terminal-browser-cdp-proxy-logging.js";
import {
  broadcastTargetCreated,
  canUseTarget,
  getCurrentTargetInfos,
  getFirstWindowId,
  getScopedTargets,
  getTargetInfoForRequest,
  isSafeNoopCommand,
  sendJson,
} from "./terminal-browser-cdp-proxy-utils.js";
import {
  handleBrowserSessionMessage,
  handleSessionMessage,
} from "./terminal-browser-cdp-proxy-session-messages.js";

const MAX_AI_TABS = 10;

export async function handleMessage(
  connections: Set<CdpProxyConnectionState>,
  conn: CdpProxyConnectionState,
  id: number,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
): Promise<void> {
  const { ws, sessionManager } = conn;

  if (sessionId) {
    if (conn.browserSessionIds.has(sessionId)) {
      await handleBrowserSessionMessage(conn, id, method, params, sessionId);
      return;
    }
    await handleSessionMessage(conn, id, method, params, sessionId);
    return;
  }

  if (isBlockedCommand(method)) {
    sendJson(
      ws,
      buildCdpError(id, -32601, `${method} is blocked by CDP proxy`),
    );
    return;
  }

  if (isSafeNoopCommand(method)) {
    sendJson(ws, buildCdpResult(id, {}));
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
        const targets = getCurrentTargetInfos(
          sessionManager,
          conn.scopedGroupId,
        );
        sendJson(ws, buildCdpResult(id, { targetInfos: targets }));
        return;
      }

      case "Target.getTargetInfo": {
        const targetInfo = getTargetInfoForRequest(
          sessionManager,
          conn.scopedGroupId,
          params,
        );
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
          const targets = getCurrentTargetInfos(
            sessionManager,
            conn.scopedGroupId,
          );
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
          const targets = getScopedTargets(conn.scopedGroupId);
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
                browserContextId: t.browserGroupId,
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

      case "Target.attachToBrowserTarget": {
        const browserSessionId = randomUUID();
        conn.browserSessionIds.add(browserSessionId);
        sendJson(ws, buildCdpResult(id, { sessionId: browserSessionId }));
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
          sendJson(
            ws,
            buildCdpError(id, -32602, `Unknown target: ${targetId}`),
          );
          return;
        }
        try {
          const target = getTerminalBrowserCdpTargets().find(
            (t) =>
              t.targetId === targetId &&
              (!conn.scopedGroupId || t.browserGroupId === conn.scopedGroupId),
          );
          if (!target) {
            sendJson(
              ws,
              buildCdpError(id, -32602, `Target not found: ${targetId}`),
            );
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

      case "Target.detachFromTarget": {
        const detachSessionId =
          typeof params.sessionId === "string" ? params.sessionId : null;
        if (detachSessionId && conn.browserSessionIds.delete(detachSessionId)) {
          sendJson(ws, buildCdpResult(id, {}));
          return;
        }
        const targetId =
          (typeof params.targetId === "string" ? params.targetId : null) ??
          (detachSessionId
            ? sessionManager.getTargetIdForSession(detachSessionId)
            : null);
        if (targetId && canUseTarget(conn, targetId)) {
          sessionManager.detachDebugger(targetId);
        }
        sendJson(ws, buildCdpResult(id, {}));
        return;
      }

      case "Target.activateTarget": {
        const targetId = params.targetId as string;
        if (!targetId) {
          sendJson(ws, buildCdpError(id, -32602, "targetId required"));
          return;
        }
        if (!canUseTarget(conn, targetId)) {
          sendJson(
            ws,
            buildCdpError(id, -32602, `Unknown target: ${targetId}`),
          );
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

        const allTargets = getTerminalBrowserCdpTargets();
        const currentTargets = getScopedTargets(conn.scopedGroupId);
        if (conn.scopedGroupId && currentTargets.length === 0) {
          sendJson(
            ws,
            buildCdpError(id, -32602, `Unknown group: ${conn.scopedGroupId}`),
          );
          return;
        }
        if (allTargets.length >= MAX_AI_TABS) {
          sendJson(
            ws,
            buildCdpError(
              id,
              -32000,
              `Maximum AI tab limit (${MAX_AI_TABS}) reached`,
            ),
          );
          return;
        }

        const windowId = resolveCreateTargetWindowId(
          currentTargets,
          sessionManager.getAttachedTargetIds(),
          getFirstWindowId(),
        );
        if (windowId === null) {
          sendJson(
            ws,
            buildCdpError(id, -32000, "No Electron window available"),
          );
          return;
        }

        const created = await createTerminalBrowserTabFromProxy(
          windowId,
          url,
          conn.scopedGroupId ?? undefined,
        );
        if (!created) {
          sendJson(ws, buildCdpError(id, -32000, "Failed to create tab"));
          return;
        }

        broadcastTargetCreated(connections, conn, {
          targetId: created.targetId,
          browserGroupId: created.browserGroupId,
          url,
          title: "",
        });

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
                  browserContextId: created.browserGroupId,
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
        if (!canUseTarget(conn, targetId)) {
          sendJson(
            ws,
            buildCdpError(id, -32602, `Unknown target: ${targetId}`),
          );
          return;
        }
        const success = closeTerminalBrowserTabFromProxy(targetId);
        if (!success) {
          sessionManager.detachDebugger(targetId);
        }
        sendJson(ws, buildCdpResult(id, { success }));
        return;
      }

      case "Storage.getCookies":
        sendJson(ws, buildCdpResult(id, { cookies: [] }));
        return;

      case "Storage.setCookies":
        sendJson(ws, buildCdpResult(id, {}));
        return;

      default:
        if (cls === "session") {
          sendJson(
            ws,
            buildCdpError(id, -32601, `${method} requires a sessionId`),
          );
        } else {
          // For unhandled browser-level commands (e.g. Browser.setDownloadBehavior),
          // return an empty success so Playwright's init sequence doesn't break.
          if (CDP_PROXY_TRACE_ENABLED) {
            console.info("[cdp-proxy] stub OK for unhandled browser command", {
              id,
              method,
            });
          }
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
