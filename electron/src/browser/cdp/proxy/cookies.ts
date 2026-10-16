import { getTerminalBrowserSession } from "../../runtime.js";
import type { CdpProxyConnectionState } from "./types.js";
import { getScopedTargets, sendJson } from "./utils.js";

/** Storage's browser contexts are virtual groups here; cookies belong to the Profile. */
export async function handleCookieCommand(
  conn: CdpProxyConnectionState,
  id: number,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
): Promise<boolean> {
  if (method !== "Storage.getCookies" && method !== "Storage.setCookies")
    return false;

  const envelope = { id, ...(sessionId ? { sessionId } : {}) };
  const fail = (code: number, message: string) =>
    sendJson(conn.ws, { ...envelope, error: { code, message } });
  const writing = method === "Storage.setCookies";
  if (
    Object.keys(params).some(
      (key) => key !== "browserContextId" && !(writing && key === "cookies"),
    ) ||
    (params.browserContextId !== undefined &&
      typeof params.browserContextId !== "string") ||
    (writing && !Array.isArray(params.cookies))
  ) {
    fail(-32602, "Invalid Cookie command parameters");
    return true;
  }
  // The existing Profile persistence listener promotes session cookies through
  // Electron.cookies.set, whose API cannot preserve a partition key. Reject the
  // whole request before writing instead of creating an unpartitioned copy.
  if (
    writing &&
    (params.cookies as unknown[]).some(
      (cookie) =>
        cookie !== null &&
        typeof cookie === "object" &&
        "partitionKey" in cookie &&
        (!("expires" in cookie) ||
          typeof cookie.expires !== "number" ||
          cookie.expires < 0),
    )
  ) {
    fail(-32602, "Partitioned session Cookies are not supported by Profile persistence");
    return true;
  }

  const targets = getScopedTargets(conn.scopedProfileId, conn.scopedGroupId);
  const contextId = params.browserContextId;
  if (
    contextId !== undefined &&
    !targets.some((target) => target.browserGroupId === contextId)
  ) {
    fail(-32602, "Unknown browserContextId in this connection");
    return true;
  }
  const targetSession = sessionId && !conn.browserSessionIds.has(sessionId);
  const targetId = targetSession
    ? conn.sessionManager.getTargetIdForSession(sessionId)
    : null;
  // Local previews use separate partitions. Never choose one as the Profile's store.
  const profileSession = getTerminalBrowserSession(conn.scopedProfileId);
  const target = targets.find(
    (candidate) =>
      (!targetSession || candidate.targetId === targetId) &&
      (contextId === undefined || candidate.browserGroupId === contextId) &&
      candidate.webContents.session === profileSession,
  );
  if (!target) {
    fail(-32000, "No live Profile browser target available for Cookie command");
    return true;
  }

  try {
    conn.sessionManager.attachDebugger(target.targetId, target.webContents);
    // Network commands use this page's storage partition. Forwarding Storage
    // directly would resolve Chromium's default browser context instead.
    // Use native CDP shapes (including partition keys), without frame-ID rewriting.
    const result: object = await target.webContents.debugger.sendCommand(
      writing ? "Network.setCookies" : "Network.getAllCookies",
      writing ? { cookies: params.cookies } : {},
    );
    sendJson(conn.ws, { ...envelope, result });
  } catch (error) {
    fail(-32000, error instanceof Error ? error.message : String(error));
  }
  return true;
}
