import "dotenv/config";
import http from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { BrowserService } from "./browser/service";
import { loadAuthConfig } from "./auth/config";
import { createRequireAuth } from "./auth/middleware";
import { AuthService } from "./auth/service";
import { resolveDevtoolsEnabled } from "./config/devtools";
import { createAuthRouter } from "./routes/auth";
import { createSessionRouter } from "./routes/session";
import { createTestRouter } from "./routes/test";
import { createCorsMiddleware } from "./server/cors";
import { SessionManager } from "./session/manager";
import { SQLiteSessionStore } from "./session/sqlite-store";
import { listenWithFallback } from "./server/listen";
import { resolveStoragePaths } from "./utils/path";
import { attachWebSocketServer } from "./ws/server";
import { resolvePageByTargetId } from "./ws/tab-target";

interface RuntimeConfig {
  preferredPort: number;
  strictPort: boolean;
  host: string | undefined;
}

interface RuntimeServices {
  authService: AuthService;
  sessionManager: SessionManager;
  browserService: BrowserService;
}

const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const CURRENT_DIR_PATH = path.dirname(CURRENT_FILE_PATH);

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
}): string {
  const { revision, wsEndpoint } = params;
  return `https://chrome-devtools-frontend.appspot.com/serve_rev/@${encodeURIComponent(revision)}/inspector.html?ws=${encodeURIComponent(wsEndpoint)}`;
}

async function resolveChromiumRevision(
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

async function resolveTargetIdForSessionTab(params: {
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

function readCliOption(optionName: string): string | undefined {
  const longOption = `--${optionName}`;

  for (let index = 2; index < process.argv.length; index += 1) {
    const current = process.argv[index];
    if (current == null) {
      continue;
    }

    if (current === longOption) {
      return process.argv[index + 1];
    }

    if (current.startsWith(`${longOption}=`)) {
      return current.slice(longOption.length + 1);
    }
  }

  return undefined;
}

function parsePort(rawValue: string | undefined, fallbackPort: number): number {
  if (!rawValue) {
    return fallbackPort;
  }

  const port = Number(rawValue.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${JSON.stringify(rawValue)}`);
  }

  return port;
}

function resolveRuntimeConfig(): RuntimeConfig {
  const rawCliPort = readCliOption("port");
  const rawHost = readCliOption("host") ?? process.env.HOST;

  return {
    preferredPort: parsePort(rawCliPort ?? process.env.PORT, 5000),
    strictPort:
      rawCliPort != null ||
      process.env.PORT_STRICT?.trim().toLowerCase() === "true",
    host: rawHost?.trim() || undefined,
  };
}

function parseConfiguredOrigins(rawOrigins: string | undefined): string[] {
  return (rawOrigins ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function resolveFrontendDistDir(): string {
  return path.resolve(CURRENT_DIR_PATH, "../../frontend/dist");
}

async function createRuntimeServices(): Promise<RuntimeServices> {
  const storagePaths = resolveStoragePaths(process.env);
  const devtoolsEnabled = resolveDevtoolsEnabled(process.env);
  const rawRemoteDebuggingPort = process.env.BROWSER_REMOTE_DEBUGGING_PORT;
  const browserService = new BrowserService({
    headless: process.env.BROWSER_HEADLESS?.trim().toLowerCase() !== "false",
    profileDir: storagePaths.browserProfileDir,
    autoOpenDevtoolsForTabs:
      process.env.BROWSER_AUTO_OPEN_DEVTOOLS?.trim().toLowerCase() === "true",
    devtoolsEnabled,
    remoteDebuggingPort: devtoolsEnabled
      ? parsePort(rawRemoteDebuggingPort, 9222)
      : undefined,
  });
  const authService = new AuthService(loadAuthConfig());
  const sessionStore = new SQLiteSessionStore(storagePaths.sessionDbFile);
  const sessionManager = new SessionManager(browserService, sessionStore);
  await sessionManager.initialize();

  return { authService, sessionManager, browserService };
}

function createHttpApp(services: RuntimeServices): express.Express {
  const app = express();
  const requireAuth = createRequireAuth(services.authService);
  const devtoolsEnabled = services.sessionManager.isDevtoolsEnabled();

  app.use(express.json());
  app.use(
    createCorsMiddleware(parseConfiguredOrigins(process.env.FRONTEND_ORIGIN)),
  );

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/test", createTestRouter());
  app.use("/api/auth", createAuthRouter(services.authService));
  app.use("/api", requireAuth, createSessionRouter(services.sessionManager));

  if (devtoolsEnabled) {
    app.get("/devtools", async (req, res) => {
      const sessionId = req.query.sessionId;
      const token = req.query.token;
      const tabId = req.query.tabId;

      if (
        typeof sessionId !== "string" ||
        typeof token !== "string" ||
        typeof tabId !== "string"
      ) {
        res.status(400).send("Missing required devtools query params");
        return;
      }

      const remoteDebuggingPort =
        services.sessionManager.getRemoteDebuggingPort(sessionId);
      if (remoteDebuggingPort == null) {
        console.error(
          "[viewer-be] devtools shell missing remote debugging port",
        );
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
        sessionManager: services.sessionManager,
        sessionId,
        tabId,
      });
      if (!targetId) {
        console.error(
          "[viewer-be] devtools shell failed to resolve target id",
          {
            sessionId,
            tabId,
          },
        );
        res.status(404).send("Target not found");
        return;
      }

      const wsEndpoint = `127.0.0.1:${remoteDebuggingPort}/devtools/page/${encodeURIComponent(targetId)}`;
      const devtoolsUrl = buildDevtoolsFrontendUrl({
        revision,
        wsEndpoint,
      });
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.send(buildDevtoolsShellHtml(devtoolsUrl));
    });
  }

  const frontendDistDir = resolveFrontendDistDir();
  if (existsSync(frontendDistDir)) {
    app.use(express.static(frontendDistDir));

    app.get("*", (req, res, next) => {
      if (
        req.path.startsWith("/api") ||
        req.path.startsWith("/ws") ||
        req.path.startsWith("/devtools")
      ) {
        next();
        return;
      }

      res.sendFile(path.join(frontendDistDir, "index.html"));
    });
  }

  return app;
}

function attachLifecycleHandlers(
  server: http.Server,
  sessionManager: SessionManager,
): void {
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    server.close();
    await sessionManager.dispose();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
}

async function startRuntime(): Promise<void> {
  const runtimeConfig = resolveRuntimeConfig();
  const services = await createRuntimeServices();
  const app = createHttpApp(services);
  const server = http.createServer(app);

  const devtoolsEnabled = services.sessionManager.isDevtoolsEnabled();

  attachWebSocketServer(server, services.sessionManager, services.authService, {
    devtoolsEnabled,
  });

  await listenWithFallback(server, runtimeConfig.preferredPort, {
    host: runtimeConfig.host,
    maxAttempts: runtimeConfig.strictPort ? 1 : undefined,
  });

  attachLifecycleHandlers(server, services.sessionManager);
}

void startRuntime();
