const BLOCKED_COMMANDS = new Set([
  "Browser.close",
  "Browser.crash",
  "Target.setRemoteLocations",
  "SystemInfo.getProcessInfo",
  "Security.setIgnoreCertificateErrors",
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
  "Storage.clearDataForOrigin",
]);

const BROWSER_COMMANDS = new Set([
  "Browser.getVersion",
]);

const TARGET_COMMANDS = new Set([
  "Target.getTargets",
  "Target.getTargetInfo",
  "Target.setDiscoverTargets",
  "Target.setAutoAttach",
  "Target.attachToTarget",
  "Target.activateTarget",
  "Target.createTarget",
  "Target.closeTarget",
]);

export interface CdpTargetInfo {
  targetId: string;
  type: "page";
  title: string;
  url: string;
  attached: boolean;
  browserContextId: string;
}

export interface CdpTargetWindowInfo {
  targetId: string;
  windowId: number;
}

export function isBlockedCommand(method: string): boolean {
  return BLOCKED_COMMANDS.has(method);
}

export type CdpCommandClass = "browser" | "target" | "session" | "blocked";

export function classifyCdpCommand(method: string): CdpCommandClass {
  if (BLOCKED_COMMANDS.has(method)) {
    return "blocked";
  }
  if (TARGET_COMMANDS.has(method)) {
    return "target";
  }
  // All Browser.* commands are browser-level (e.g. Browser.setDownloadBehavior).
  if (method.startsWith("Browser.") || BROWSER_COMMANDS.has(method)) {
    return "browser";
  }
  return "session";
}

export function buildVersionResponse(wsUrl: string): object {
  return {
    Browser: "Runweave/CDP-Proxy",
    "Protocol-Version": "1.3",
    "User-Agent": "Runweave/CDP-Proxy",
    "V8-Version": "",
    "WebKit-Version": "",
    webSocketDebuggerUrl: wsUrl,
  };
}

export function buildTargetInfo(target: {
  targetId: string;
  url: string;
  title: string;
  attached?: boolean;
}): CdpTargetInfo {
  return {
    targetId: target.targetId,
    type: "page",
    title: target.title,
    url: target.url,
    attached: target.attached ?? false,
    browserContextId: "runweave-terminal-browser",
  };
}

export function isCdpConnectionLimitReached(
  activeConnectionCount: number,
  maxConnectionCount: number,
): boolean {
  return activeConnectionCount >= maxConnectionCount;
}

export function shouldSendTargetCreatedEvent(
  discoveryEnabled: boolean,
  isInitiatorConnection: boolean,
): boolean {
  return discoveryEnabled && !isInitiatorConnection;
}

export function resolveCreateTargetWindowId(
  targets: CdpTargetWindowInfo[],
  attachedTargetIds: string[],
  fallbackWindowId: number | null,
): number | null {
  for (const targetId of attachedTargetIds) {
    const attachedTarget = targets.find((target) => target.targetId === targetId);
    if (attachedTarget) {
      return attachedTarget.windowId;
    }
  }

  return targets[0]?.windowId ?? fallbackWindowId;
}

export function validateNavigateParams(params: {
  url?: string;
}): { ok: true } | { ok: false; error: string } {
  if (!params.url || params.url === "about:blank") {
    return { ok: true };
  }
  try {
    const parsed = new URL(params.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        ok: false,
        error: `Navigation to ${parsed.protocol} URLs is not allowed`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
}

export function validateSetContentParams(params: {
  html?: string;
}): { ok: true } | { ok: false; error: string } {
  if (!params.html) {
    return { ok: true };
  }
  const dangerous = /\b(?:file|chrome|devtools|javascript):/i;
  if (dangerous.test(params.html)) {
    return {
      ok: false,
      error: "Page.setDocumentContent cannot contain file:, chrome:, devtools:, or javascript: references",
    };
  }
  return { ok: true };
}

const QUIT_KEYS = new Set(["q", "w"]);

export function validateKeyEvent(params: {
  type?: string;
  modifiers?: number;
  key?: string;
}): { ok: true } | { ok: false; error: string } {
  const modifiers = params.modifiers ?? 0;
  const hasMeta = (modifiers & 4) !== 0;
  const key = (params.key ?? "").toLowerCase();
  if (hasMeta && QUIT_KEYS.has(key)) {
    return { ok: false, error: "Window close/quit shortcuts are blocked" };
  }
  return { ok: true };
}

export function buildCdpError(
  id: number,
  code: number,
  message: string,
): object {
  return { id, error: { code, message } };
}

export function buildCdpResult(id: number, result: object): object {
  return { id, result };
}

export function buildCdpSessionResult(
  id: number,
  sessionId: string,
  result: object,
): object {
  return { id, sessionId, result };
}

export function buildCdpSessionError(
  id: number,
  sessionId: string,
  code: number,
  message: string,
): object {
  return { id, sessionId, error: { code, message } };
}
