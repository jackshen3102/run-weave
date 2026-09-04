import { WebSocket } from "ws";
import type { CdpSessionManager } from "./session.js";
import {
  buildTargetInfo,
  shouldSendTargetCreatedEvent,
  type CdpTargetInfo,
} from "./handler.js";
import { getTerminalBrowserCdpTargets } from "../../view/index.js";
import type { CdpProxyConnectionState } from "./types.js";
import { CDP_PROXY_TRACE_ENABLED } from "./logging.js";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
import { desktopRuntime } from "../../../desktop/runtime-state.js";

export function getTerminalBrowserOwnerWindowId(): number | null {
  const mainWindow = desktopRuntime.mainWindow;
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow.id : null;
}

export function canUseTarget(
  conn: CdpProxyConnectionState,
  targetId: string,
): boolean {
  return getTerminalBrowserCdpTargets().some(
    (target) =>
      target.targetId === targetId &&
      target.profileId === conn.scopedProfileId &&
      (!conn.scopedGroupId || target.browserGroupId === conn.scopedGroupId),
  );
}

export function getScopedTargets(
  scopedProfileId: TerminalBrowserProfileId,
  scopedGroupId: string | null,
) {
  return getTerminalBrowserCdpTargets().filter(
    (target) =>
      target.profileId === scopedProfileId &&
      (!scopedGroupId || target.browserGroupId === scopedGroupId),
  );
}

export function sendJson(ws: WebSocket, data: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    if (CDP_PROXY_TRACE_ENABLED) {
      const payload = data as Record<string, unknown>;
      console.info("[cdp-proxy] >>", {
        id: payload.id ?? null,
        method: payload.method ?? null,
        sessionId: payload.sessionId ?? null,
      });
    }
    ws.send(JSON.stringify(data));
  }
}

export function getCurrentTargetInfos(
  sessionManager: CdpSessionManager,
  scopedProfileId: TerminalBrowserProfileId,
  scopedGroupId: string | null,
): CdpTargetInfo[] {
  return getScopedTargets(scopedProfileId, scopedGroupId).map((t) =>
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
  scopedProfileId: TerminalBrowserProfileId,
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
  const targets = getCurrentTargetInfos(
    sessionManager,
    scopedProfileId,
    scopedGroupId,
  );

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
    profileId: TerminalBrowserProfileId;
    browserGroupId: string;
    url: string;
    title: string;
  },
): void {
  for (const conn of connections) {
    if (conn.scopedProfileId !== target.profileId) {
      continue;
    }
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
