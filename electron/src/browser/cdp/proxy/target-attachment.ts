import type { CdpProxyConnectionState } from "./types.js";
import { canUseTarget, getScopedTargets } from "./utils.js";

export function attachProxyTarget(conn: CdpProxyConnectionState, params: Record<string, unknown>) {
  const target = getScopedTargets(conn.scopedProfileId, conn.scopedGroupId)
    .find(target => target.targetId === params.targetId);
  if (!target) throw new Error("Target not found in this Profile/Group");
  return { sessionId: conn.sessionManager.attachDebugger(target.targetId, target.webContents).proxySessionId };
}

export function detachProxyTarget(conn: CdpProxyConnectionState, params: Record<string, unknown>, fallback?: string): void {
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : fallback;
  if (sessionId && conn.browserSessionIds.delete(sessionId)) return;
  const targetId = typeof params.targetId === "string" ? params.targetId
    : sessionId ? conn.sessionManager.getTargetIdForSession(sessionId) : null;
  if (!targetId || !canUseTarget(conn, targetId)) throw new Error("Target/session not found in this Profile/Group");
  conn.sessionManager.detachDebugger(targetId);
}
