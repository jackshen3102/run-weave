import { Router } from "express";
import type { Request, RequestHandler } from "express";
import { readBearerToken } from "../auth/middleware";
import type { SessionManager } from "../session/manager";
import { resolvePageByTargetId } from "../ws/tab-target";

interface CreateDevtoolsRouterOptions {
  authService: {
    verifyToken: (token: string) => boolean;
  };
  sessionManager: SessionManager;
  resolveChromiumRevision?: (
    remoteDebuggingPort: number,
  ) => Promise<string | null>;
  resolveTargetIdForSessionTab?: (params: {
    sessionManager: SessionManager;
    sessionId: string;
    tabId: string;
  }) => Promise<string | null>;
}

function resolveAccessToken(request: Request): string | null {
  const bearerToken = readBearerToken(request);
  if (bearerToken) {
    return bearerToken;
  }

  const ticket = request.query.ticket;
  if (typeof ticket === "string" && ticket.trim()) {
    return ticket;
  }

  return null;
}

function buildDevtoolsShellHtml(devtoolsUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevTools</title>
    <style>
      html, body, iframe {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        border: 0;
        background: #111;
      }
    </style>
  </head>
  <body>
    <iframe id="devtools-frame" title="DevTools" src=${JSON.stringify(devtoolsUrl)}></iframe>
  </body>
</html>`;
}

function buildDevtoolsFrontendUrl(params: {
  revision: string;
  wsEndpoint: string;
  wsProtocol: "ws" | "wss";
}): string {
  const { revision, wsEndpoint, wsProtocol } = params;
  return `https://chrome-devtools-frontend.appspot.com/serve_rev/@${encodeURIComponent(revision)}/inspector.html?${wsProtocol}=${encodeURIComponent(wsEndpoint)}`;
}

function readForwardedHeader(
  request: Request,
  headerName: "x-forwarded-host" | "x-forwarded-proto",
): string | null {
  const value = request.headers[headerName];
  if (typeof value !== "string") {
    return null;
  }

  const [first] = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return first ?? null;
}

function resolveRequestHost(request: Request): string {
  return (
    readForwardedHeader(request, "x-forwarded-host") ??
    request.headers.host ??
    "127.0.0.1"
  );
}

function resolveWebSocketProtocol(request: Request): "ws" | "wss" {
  const forwardedProto = readForwardedHeader(request, "x-forwarded-proto");
  if (forwardedProto === "https") {
    return "wss";
  }
  if (forwardedProto === "http") {
    return "ws";
  }

  return request.socket?.encrypted ? "wss" : "ws";
}

function buildDevtoolsProxyEndpoint(params: {
  request: Request;
  sessionId: string;
  tabId: string;
  token: string;
}): string {
  const { request, sessionId, tabId, token } = params;
  const host = resolveRequestHost(request);
  const search = new URLSearchParams({
    sessionId,
    tabId,
    token,
  });

  return `${host}/ws/devtools-proxy?${search.toString()}`;
}

async function defaultResolveChromiumRevision(
  remoteDebuggingPort: number,
): Promise<string | null> {
  const endpoint = `http://127.0.0.1:${remoteDebuggingPort}/json/version`;

  try {
    const response = await fetch(endpoint);
    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      "WebKit-Version"?: unknown;
      Browser?: unknown;
    };

    const webkitVersion =
      typeof payload["WebKit-Version"] === "string"
        ? payload["WebKit-Version"]
        : "";
    const revisionFromWebKit = webkitVersion.match(/@([0-9a-f]{6,40})/i)?.[1];
    if (revisionFromWebKit) {
      return revisionFromWebKit;
    }

    const browserVersion =
      typeof payload.Browser === "string" ? payload.Browser : "";
    const revisionFromBrowser =
      browserVersion.match(/\b([0-9a-f]{6,40})\b/i)?.[1];
    return revisionFromBrowser ?? null;
  } catch {
    return null;
  }
}

async function defaultResolveTargetIdForSessionTab(params: {
  sessionManager: SessionManager;
  sessionId: string;
  tabId: string;
}): Promise<string | null> {
  const { sessionManager, sessionId, tabId } = params;
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    return null;
  }

  const page = await resolvePageByTargetId(
    session.browserSession.context,
    tabId,
  );
  if (!page) {
    return null;
  }

  return tabId;
}

export function createDevtoolsRouter(
  options: CreateDevtoolsRouterOptions,
): Router {
  const router = Router();
  router.get("/", createDevtoolsHandler(options));
  return router;
}

export function createDevtoolsHandler(
  options: CreateDevtoolsRouterOptions,
): RequestHandler {
  const resolveChromiumRevision =
    options.resolveChromiumRevision ?? defaultResolveChromiumRevision;
  const resolveTargetIdForSessionTab =
    options.resolveTargetIdForSessionTab ?? defaultResolveTargetIdForSessionTab;

  return async (req, res) => {
    const sessionId = req.query.sessionId;
    const tabId = req.query.tabId;
    const token = resolveAccessToken(req);

    if (typeof sessionId !== "string" || typeof tabId !== "string" || !token) {
      res.status(400).send("Missing required sessionId or tabId");
      return;
    }

    if (!options.authService.verifyToken(token)) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const remoteDebuggingPort =
      options.sessionManager.getRemoteDebuggingPort(sessionId);
    if (remoteDebuggingPort == null) {
      console.error("[viewer-be] devtools shell missing remote debugging port");
      res.status(503).send("Remote debugging is unavailable");
      return;
    }

    const revision = await resolveChromiumRevision(remoteDebuggingPort);
    if (!revision) {
      console.error("[viewer-be] devtools shell failed to resolve revision", {
        remoteDebuggingPort,
      });
      res.status(502).send("Failed to resolve Chromium revision");
      return;
    }

    const targetId = await resolveTargetIdForSessionTab({
      sessionManager: options.sessionManager,
      sessionId,
      tabId,
    });
    if (!targetId) {
      console.error("[viewer-be] devtools shell failed to resolve target id", {
        sessionId,
        tabId,
      });
      res.status(404).send("Target not found");
      return;
    }

    const wsEndpoint = buildDevtoolsProxyEndpoint({
      request: req,
      sessionId,
      tabId: targetId,
      token,
    });
    const devtoolsUrl = buildDevtoolsFrontendUrl({
      revision,
      wsEndpoint,
      wsProtocol: resolveWebSocketProtocol(req),
    });
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(buildDevtoolsShellHtml(devtoolsUrl));
  };
}
