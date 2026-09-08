import type { CdpProxyConnectionState } from "../cdp/proxy/types.js";
import { canUseTarget, sendJson } from "../cdp/proxy/utils.js";
import {
  buildCdpSessionError,
  buildCdpSessionResult,
} from "../cdp/proxy/handler.js";
import { getTerminalBrowserEntryByTargetId } from "../view/index.js";
import { recordTerminalBrowserAutomationCommand } from "../automation/runtime.js";
import { runBrowserToolCommand } from "./runtime.js";

export async function handleBrowserToolCommand(
  conn: CdpProxyConnectionState,
  id: number,
  method: string,
  params: Record<string, unknown>,
  sessionId: string,
): Promise<void> {
  const targetId = conn.sessionManager.getTargetIdForSession(sessionId);
  const entry =
    targetId && canUseTarget(conn, targetId)
      ? getTerminalBrowserEntryByTargetId(targetId)?.entry
      : null;
  if (!entry) {
    sendJson(
      conn.ws,
      buildCdpSessionError(
        id,
        sessionId,
        -32000,
        "Target is outside this Profile/Group or closed",
      ),
    );
    return;
  }
  const isCall = method === "Runweave.callBrowserTool";
  const valid = isCall
    ? Object.keys(params).length === 2 &&
      typeof params.toolId === "string" &&
      params.toolId.length <= 128 &&
      params.arguments !== null &&
      typeof params.arguments === "object" &&
      !Array.isArray(params.arguments) &&
      JSON.stringify(params.arguments).length <= 64 * 1024
    : Object.keys(params).length === 0;
  if (!valid) {
    sendJson(
      conn.ws,
      buildCdpSessionError(
        id,
        sessionId,
        -32602,
        "Expected toolId and JSON object arguments (at most 64 KiB), or no parameters for list",
      ),
    );
    return;
  }
  const result = await runBrowserToolCommand(
    entry.view.webContents,
    isCall
      ? {
          toolId: params.toolId as string,
          arguments: params.arguments as Record<string, unknown>,
        }
      : null,
    (name, status) =>
      recordTerminalBrowserAutomationCommand(
        conn.connectionId,
        targetId!,
        "Runweave.callBrowserTool",
        { tool: { name, status } },
      ),
  );
  sendJson(conn.ws, buildCdpSessionResult(id, sessionId, result));
}
