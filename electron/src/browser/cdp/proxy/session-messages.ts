import {
  buildCdpSessionError,
  buildCdpSessionResult,
  classifyCdpCommand,
  isBlockedCommand,
  validateKeyEvent,
  validateNavigateParams,
  validateSetContentParams,
} from "./handler.js";
import {
  DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE,
  isTerminalBrowserDisplayScale,
} from "@runweave/shared/terminal-browser-display-scale";
import {
  closeTerminalBrowserTabFromProxy,
  getTerminalBrowserDisplayScaleForTarget,
  setTerminalBrowserDisplayScaleForTarget,
} from "../../view/index.js";
import type { CdpProxyConnectionState } from "./types.js";
import { handleBrowserToolCommand } from "../../webmcp/handler.js";
import { attachProxyTarget, detachProxyTarget } from "./target-attachment.js";
import {
  getCurrentTargetInfos,
  getTargetInfoForRequest,
  canUseTarget,
  sendJson,
} from "./utils.js";

export async function handleBrowserSessionMessage(
  conn: CdpProxyConnectionState,
  id: number,
  method: string,
  params: Record<string, unknown>,
  sessionId: string,
): Promise<void> {
  const { ws } = conn;

  if (method === "Target.attachToTarget" || method === "Target.detachFromTarget") {
    try {
      const result = method === "Target.attachToTarget" ? attachProxyTarget(conn, params)
        : (detachProxyTarget(conn, params, sessionId), {});
      sendJson(ws, buildCdpSessionResult(id, sessionId, result));
    } catch (error) {
      sendJson(ws, buildCdpSessionError(id, sessionId, -32602,
        error instanceof Error ? error.message : "Invalid target attachment"));
    }
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
      conn.scopedProfileId,
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
      conn.scopedProfileId,
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

  const cls = classifyCdpCommand(method);
  if (cls === "browser" || cls === "target") {
    sendJson(ws, buildCdpSessionError(id, sessionId, -32601,
      `${method} is unsupported on a Browser session; use the root connection for Target operations`));
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

export async function handleSessionMessage(
  conn: CdpProxyConnectionState,
  id: number,
  method: string,
  params: Record<string, unknown>,
  sessionId: string,
): Promise<void> {
  const { ws, sessionManager } = conn;

  if (method === "Runweave.listBrowserTools" || method === "Runweave.callBrowserTool") {
    await handleBrowserToolCommand(conn, id, method, params, sessionId);
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

  if (
    method === "Runweave.getDisplayScale" ||
    method === "Runweave.setDisplayScale" ||
    method === "Runweave.resetDisplayScale"
  ) {
    const targetId = sessionManager.getTargetIdForSession(sessionId);
    if (!targetId || !canUseTarget(conn, targetId)) {
      sendJson(
        ws,
        buildCdpSessionError(
          id,
          sessionId,
          -32000,
          "No terminal browser target available for session",
        ),
      );
      return;
    }

    const paramKeys = Object.keys(params);
    const validParams =
      method === "Runweave.setDisplayScale"
        ? paramKeys.length === 1 &&
          paramKeys[0] === "factor" &&
          isTerminalBrowserDisplayScale(params.factor)
        : paramKeys.length === 0;
    if (!validParams) {
      sendJson(
        ws,
        buildCdpSessionError(
          id,
          sessionId,
          -32602,
          method === "Runweave.setDisplayScale"
            ? "factor must be a supported terminal browser display scale"
            : `${method} does not accept parameters`,
        ),
      );
      return;
    }

    if (method === "Runweave.getDisplayScale") {
      const factor = getTerminalBrowserDisplayScaleForTarget(targetId);
      if (factor === null) {
        sendJson(
          ws,
          buildCdpSessionError(id, sessionId, -32000, "Browser tab is closed"),
        );
        return;
      }
      sendJson(ws, buildCdpSessionResult(id, sessionId, { factor }));
      return;
    }

    try {
      const state = await setTerminalBrowserDisplayScaleForTarget(
        targetId,
        method === "Runweave.resetDisplayScale"
          ? DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE
          : params.factor,
      );
      if (!state) {
        throw new Error("Browser tab is closed");
      }
      sendJson(ws, buildCdpSessionResult(id, sessionId, state));
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
    return;
  }

  // Intercept session-level Target.* commands — never forward these to
  // Electron's internal CDP as they would create new windows or expose
  // targets outside the Terminal Browser sandbox.
  if (method === "Target.getTargetInfo") {
    const targetInfo = getTargetInfoForRequest(
      sessionManager,
      conn.scopedProfileId,
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

  // Playwright configures child-target discovery during page initialization.
  // This proxy owns discovery at the root; never forward it to the host browser.
  if (method === "Target.setAutoAttach" || method === "Target.setDiscoverTargets") {
    sendJson(ws, buildCdpSessionResult(id, sessionId, {}));
    return;
  }
  if (method === "Target.getTargets") {
    sendJson(ws, buildCdpSessionResult(id, sessionId, {
      targetInfos: getCurrentTargetInfos(sessionManager, conn.scopedProfileId, conn.scopedGroupId),
    }));
    return;
  }
  if (method.startsWith("Target.") || method.startsWith("Browser.")) {
    sendJson(ws, buildCdpSessionError(id, sessionId, -32601,
      `${method} is unsupported on a page session; use the root connection for supported Browser/Target operations`));
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
