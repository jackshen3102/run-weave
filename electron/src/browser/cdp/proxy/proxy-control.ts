import { inspectTerminalBrowserProfileProxy, setTerminalBrowserProfileProxyMode } from "../../profile/runtime.js";
import type { CdpProxyConnectionState } from "./types.js";
import { canUseTarget, sendJson } from "./utils.js";

export async function handleProxyControlCommand(
  conn: CdpProxyConnectionState, id: number, method: string,
  params: Record<string, unknown>, sessionId?: string,
): Promise<boolean> {
  if (method !== "Runweave.getProxyState" && method !== "Runweave.setProxyMode") return false;
  const envelope = { id, ...(sessionId ? { sessionId } : {}) };
  try {
    if (sessionId && !conn.browserSessionIds.has(sessionId)) {
      const targetId = conn.sessionManager.getTargetIdForSession(sessionId);
      if (!targetId || !canUseTarget(conn, targetId)) throw new Error("BROWSER_SCOPE_DENIED");
    }
    const writing = method === "Runweave.setProxyMode";
    if (Object.keys(params).some(key => !(writing ? ["mode", "expectedMode"] : []).includes(key)) ||
        (writing && (!["direct", "whistle"].includes(String(params.mode)) ||
          !["direct", "whistle"].includes(String(params.expectedMode)))))
      throw new Error("INVALID_PROXY_ARGUMENTS: set requires mode and expectedMode; get takes no parameters");
    const profileId = conn.scopedProfileId;
    if (writing) await setTerminalBrowserProfileProxyMode(profileId, params.mode as "direct" | "whistle", {
      expectedMode: params.expectedMode as "direct" | "whistle", reloadPages: false,
    });
    const result = await inspectTerminalBrowserProfileProxy(profileId);
    sendJson(conn.ws, { ...envelope, result });
  } catch (error) {
    sendJson(conn.ws, { ...envelope, error: { code: -32000,
      message: error instanceof Error ? error.message : "Desktop proxy control failed" } });
  }
  return true;
}
