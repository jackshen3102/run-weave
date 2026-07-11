import {
  buildCdpSessionError,
  buildCdpSessionResult,
  classifyCdpCommand,
  isBlockedCommand,
  validateKeyEvent,
  validateNavigateParams,
  validateSetContentParams,
} from "./terminal-browser-cdp-proxy-handler.js";
import { closeTerminalBrowserTabFromProxy } from "./terminal-browser-view.js";
import type { CdpProxyConnectionState } from "./terminal-browser-cdp-proxy-types.js";
import {
  getCurrentTargetInfos,
  getTargetInfoForRequest,
  isSafeNoopCommand,
  sendJson,
} from "./terminal-browser-cdp-proxy-utils.js";

export async function handleBrowserSessionMessage(
  conn: CdpProxyConnectionState,
  id: number,
  method: string,
  params: Record<string, unknown>,
  sessionId: string,
): Promise<void> {
  const { ws } = conn;

  if (method === "Target.detachFromTarget") {
    const detachSessionId =
      typeof params.sessionId === "string" ? params.sessionId : sessionId;
    conn.browserSessionIds.delete(detachSessionId);
    sendJson(ws, buildCdpSessionResult(id, sessionId, {}));
    return;
  }

  if (method === "Browser.getVersion") {
    sendJson(
      ws,
      buildCdpSessionResult(id, sessionId, {
        protocolVersion: "1.3",
        product: "Runweave/CDP-Proxy",
        revision: "",
        userAgent: "Runweave/CDP-Proxy",
        jsVersion: "",
      }),
    );
    return;
  }

  if (method === "Target.getTargets") {
    const targets = getCurrentTargetInfos(
      conn.sessionManager,
      conn.scopedGroupId,
    );
    sendJson(
      ws,
      buildCdpSessionResult(id, sessionId, { targetInfos: targets }),
    );
    return;
  }

  if (method === "Target.getTargetInfo") {
    const targetInfo = getTargetInfoForRequest(
      conn.sessionManager,
      conn.scopedGroupId,
      params,
    );
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

  if (method === "Storage.getCookies") {
    sendJson(ws, buildCdpSessionResult(id, sessionId, { cookies: [] }));
    return;
  }

  if (method === "Storage.setCookies") {
    sendJson(ws, buildCdpSessionResult(id, sessionId, {}));
    return;
  }

  if (isBlockedCommand(method)) {
    sendJson(
      ws,
      buildCdpSessionError(
        id,
        sessionId,
        -32601,
        `${method} is blocked by CDP proxy`,
      ),
    );
    return;
  }

  if (isSafeNoopCommand(method)) {
    sendJson(ws, buildCdpSessionResult(id, sessionId, {}));
    return;
  }

  const cls = classifyCdpCommand(method);
  if (cls === "browser" || cls === "target") {
    sendJson(ws, buildCdpSessionResult(id, sessionId, {}));
    return;
  }

  sendJson(
    ws,
    buildCdpSessionError(
      id,
      sessionId,
      -32601,
      `${method} requires a target sessionId`,
    ),
  );
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

export async function handleSessionMessage(
  conn: CdpProxyConnectionState,
  id: number,
  method: string,
  params: Record<string, unknown>,
  sessionId: string,
): Promise<void> {
  const { ws, sessionManager } = conn;

  if (isBlockedCommand(method)) {
    sendJson(
      ws,
      buildCdpSessionError(
        id,
        sessionId,
        -32601,
        `${method} is blocked by CDP proxy`,
      ),
    );
    return;
  }

  if (isSafeNoopCommand(method)) {
    sendJson(ws, buildCdpSessionResult(id, sessionId, {}));
    return;
  }

  // Intercept session-level Target.* commands — never forward these to
  // Electron's internal CDP as they would create new windows or expose
  // targets outside the Terminal Browser sandbox.
  if (method === "Target.getTargetInfo") {
    const targetInfo = getTargetInfoForRequest(
      sessionManager,
      conn.scopedGroupId,
      params,
      sessionId,
    );
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
    console.info("[cdp-proxy] intercepted session-level Target command", {
      id,
      method,
      sessionId,
    });
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
      sendJson(
        ws,
        buildCdpSessionError(id, sessionId, -32602, contentCheck.error),
      );
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

  if (method === "Page.close") {
    const targetId = sessionManager.getTargetIdForSession(sessionId);
    if (targetId) {
      closeTerminalBrowserTabFromProxy(targetId);
    }
    sendJson(ws, buildCdpSessionResult(id, sessionId, {}));
    return;
  }

  if (method === "Runtime.runIfWaitingForDebugger") {
    try {
      const result = await sessionManager.sendCommand(
        sessionId,
        method,
        params,
      );
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
