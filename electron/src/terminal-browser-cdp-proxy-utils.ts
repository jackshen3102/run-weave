import { BrowserWindow } from "electron";
import { WebSocket } from "ws";
import type { CdpSessionManager } from "./terminal-browser-cdp-proxy-session.js";
import {
  buildTargetInfo,
  shouldSendTargetCreatedEvent,
  type CdpTargetInfo,
} from "./terminal-browser-cdp-proxy-handler.js";
import { getTerminalBrowserCdpTargets } from "./terminal-browser-view.js";
import type { CdpProxyConnectionState } from "./terminal-browser-cdp-proxy-types.js";

export function getFirstWindowId(): number | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0]!.id : null;
}

export function canUseTarget(
  conn: CdpProxyConnectionState,
  targetId: string,
): boolean {
  if (!conn.scopedGroupId) {
    return true;
  }
  return getTerminalBrowserCdpTargets().some(
    (target) =>
      target.targetId === targetId &&
      target.browserGroupId === conn.scopedGroupId,
  );
}

export function getScopedTargets(scopedGroupId: string | null) {
  return getTerminalBrowserCdpTargets().filter(
    (target) => !scopedGroupId || target.browserGroupId === scopedGroupId,
  );
}

export function sendJson(ws: WebSocket, data: object): void {
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

export function getCurrentTargetInfos(
  sessionManager: CdpSessionManager,
  scopedGroupId: string | null,
): CdpTargetInfo[] {
  return getScopedTargets(scopedGroupId).map((t) =>
    buildTargetInfo({
      targetId: t.targetId,
      url: t.url,
      title: t.title,
      browserContextId: t.browserGroupId,
      attached: sessionManager.isTargetAttached(t.targetId),
    }),
  );
}

export function getTargetInfoForRequest(
  sessionManager: CdpSessionManager,
  scopedGroupId: string | null,
  params: Record<string, unknown>,
  sessionId?: string,
): CdpTargetInfo | null {
  const requestedTargetId =
    typeof params.targetId === "string" ? params.targetId : null;
  const sessionTargetId = sessionId
    ? sessionManager.getTargetIdForSession(sessionId)
    : null;
  const targetId = requestedTargetId ?? sessionTargetId;
  const targets = getCurrentTargetInfos(sessionManager, scopedGroupId);

  if (targetId) {
    return targets.find((target) => target.targetId === targetId) ?? null;
  }
  return targets.find((target) => target.attached) ?? targets[0] ?? null;
}

export function broadcastTargetCreated(
  connections: Set<CdpProxyConnectionState>,
  initiator: CdpProxyConnectionState,
  target: {
    targetId: string;
    browserGroupId: string;
    url: string;
    title: string;
  },
): void {
  for (const conn of connections) {
    if (conn.scopedGroupId && conn.scopedGroupId !== target.browserGroupId) {
      continue;
    }
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
          browserContextId: target.browserGroupId,
          attached: false,
        }),
      },
    });
  }
}

export function isSafeNoopCommand(method: string): boolean {
  return (
    method === "Network.clearBrowserCache" ||
    method === "Network.clearBrowserCookies" ||
    method === "Storage.clearDataForOrigin"
  );
}
