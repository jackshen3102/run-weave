import "dotenv/config";
import http from "node:http";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import express from "express";
import { LowDbAuthStore } from "./auth/lowdb-store";
import { BrowserService } from "./browser/service";
import { loadAuthConfig } from "./auth/config";
import { createRequireAuth } from "./auth/middleware";
import { AuthService } from "./auth/service";
import type { AuthStore } from "./auth/store";
import { resolveDevtoolsEnabled } from "./config/devtools";
import { diagnosticLogRecorder } from "./diagnostic-logs/recorder";
import { createAuthRouter } from "./routes/auth";
import { createDiagnosticLogsRouter } from "./routes/diagnostic-logs";
import { createDevtoolsRouter } from "./routes/devtools";
import { QualityProbeStore } from "./quality/probe-store";
import { createQualityRouter } from "./routes/quality";
import { createSessionRouter } from "./routes/session";
import { createInternalTerminalCompletionRouter } from "./routes/terminal-completion";
import { createTerminalRouter } from "./routes/terminal";
import { createTestRouter } from "./routes/test";
import { createCorsMiddleware } from "./server/cors";
import { resolveFrontendDistDir } from "./server/frontend-dist";
import { SessionManager } from "./session/manager";
import { TERMINAL_CLIPBOARD_IMAGE_JSON_LIMIT } from "./terminal/clipboard-image";
import { LowDbSessionStore } from "./session/lowdb-store";
import { TerminalSessionManager } from "./terminal/manager";
import { TerminalCompletionEventStore } from "./terminal/completion-events";
import { PtyService } from "./terminal/pty-service";
import { TerminalRuntimeRegistry } from "./terminal/runtime-registry";
import { TmuxService } from "./terminal/tmux-service";
import { LowDbTerminalSessionStore } from "./terminal/lowdb-store";
import { listenWithFallback } from "./server/listen";
import { resolveStoragePaths } from "./utils/path";
import { attachAiBridgeProxyServer } from "./ws/ai-bridge-proxy";
import { attachDevtoolsProxyServer } from "./ws/devtools-proxy";
import { WebSocketSessionController } from "./ws/session-control";
import { attachTerminalWebSocketServer } from "./ws/terminal-server";
import { attachWebSocketServer } from "./ws/server";

interface RuntimeConfig {
  preferredPort: number;
  strictPort: boolean;
  host: string | undefined;
}

interface RuntimeServices {
  authStore: AuthStore;
  authService: AuthService;
  authCookieName: string;
  authSecureCookies: boolean;
  sessionManager: SessionManager;
  browserService: BrowserService;
  qualityProbeStore: QualityProbeStore;
  wsSessionController: WebSocketSessionController;
  aiBridgeSessionController: WebSocketSessionController;
  terminalSessionManager: TerminalSessionManager;
  terminalCompletionEventStore: TerminalCompletionEventStore;
  terminalRuntimeRegistry: TerminalRuntimeRegistry;
  ptyService: PtyService;
  tmuxService: TmuxService;
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

function resolveSessionRestoreEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.SESSION_RESTORE_ENABLED?.trim().toLowerCase() === "true";
}

function resolveTerminalHookToken(env: NodeJS.ProcessEnv): string {
  const existing = env.RUNWEAVE_HOOK_TOKEN?.trim();
  if (existing) {
    return existing;
  }

  return randomBytes(32).toString("hex");
}

async function createRuntimeServices(): Promise<RuntimeServices> {
  const storagePaths = resolveStoragePaths(process.env);
  const authConfig = loadAuthConfig();
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
  const authStore = new LowDbAuthStore(storagePaths.authStoreFile);
  const persistedAuth = await authStore.initialize({
    username: authConfig.username,
    password: authConfig.password,
    jwtSecret: authConfig.jwtSecret,
    updatedAt: new Date().toISOString(),
    refreshSessions: [],
  });
  const authService = new AuthService(
    {
      ...authConfig,
      username: persistedAuth.username,
      password: persistedAuth.password,
      jwtSecret: persistedAuth.jwtSecret,
      initialRefreshSessions: persistedAuth.refreshSessions,
    },
    authStore,
  );
  const sessionStore = new LowDbSessionStore(storagePaths.sessionStoreFile);
  const terminalSessionStore = new LowDbTerminalSessionStore(
    storagePaths.terminalSessionStoreFile,
  );
  const qualityProbeStore = new QualityProbeStore();
  const wsSessionController = new WebSocketSessionController();
  const aiBridgeSessionController = new WebSocketSessionController();
  const sessionManager = new SessionManager(browserService, sessionStore, {
    restorePersistedSessions: resolveSessionRestoreEnabled(process.env),
    qualityProbeStore,
  });
  const terminalSessionManager = new TerminalSessionManager(
    terminalSessionStore,
  );
  const terminalCompletionEventStore = new TerminalCompletionEventStore();
  const terminalRuntimeRegistry = new TerminalRuntimeRegistry();
  process.env.RUNWEAVE_HOOK_TOKEN = resolveTerminalHookToken(process.env);
  const ptyService = new PtyService();
  const tmuxService = new TmuxService({
    socketPath:
      process.env.TERMINAL_TMUX_SOCKET_PATH ??
      path.join(
        path.dirname(storagePaths.terminalSessionStoreFile),
        "tmux",
        "runweave.tmux.sock",
      ),
    env: process.env,
  });
  await sessionManager.initialize();
  await terminalSessionManager.initialize();

  return {
    authStore,
    authService,
    authCookieName: authConfig.refreshCookieName,
    authSecureCookies: authConfig.secureCookies,
    sessionManager,
    browserService,
    qualityProbeStore,
    wsSessionController,
    aiBridgeSessionController,
    terminalSessionManager,
    terminalCompletionEventStore,
    terminalRuntimeRegistry,
    ptyService,
    tmuxService,
  };
}

function createHttpApp(services: RuntimeServices): express.Express {
  const app = express();
  const requireAuth = createRequireAuth(services.authService);
  const devtoolsEnabled = services.sessionManager.isDevtoolsEnabled();

  app.use(express.json({ limit: TERMINAL_CLIPBOARD_IMAGE_JSON_LIMIT }));
  app.use(
    createCorsMiddleware(parseConfiguredOrigins(process.env.FRONTEND_ORIGIN)),
  );

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Internal endpoint for Electron to propagate CDP proxy endpoint in dev mode.
  // In production, the env is inherited via child process spawn.
  app.put("/internal/cdp-endpoint", (req, res) => {
    const { endpoint } = req.body as { endpoint?: string };
    if (typeof endpoint === "string" && endpoint) {
      process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT = endpoint;
      console.info("[viewer-be] CDP endpoint set via internal API", { endpoint });
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: "endpoint required" });
    }
  });

  app.use(
    "/internal/terminal-completion",
    createInternalTerminalCompletionRouter({
      completionEventStore: services.terminalCompletionEventStore,
      terminalSessionManager: services.terminalSessionManager,
      hookToken: process.env.RUNWEAVE_HOOK_TOKEN,
    }),
  );

  app.use("/test", createTestRouter());
  app.use(
    "/api/auth",
    createAuthRouter(services.authService, {
      refreshCookieName: services.authCookieName,
      secureCookies: services.authSecureCookies,
    }),
  );
  app.use(
    "/api",
    requireAuth,
    createSessionRouter(
      services.sessionManager,
      services.authService,
      services.aiBridgeSessionController,
    ),
  );
  app.use(
    "/api",
    requireAuth,
    createQualityRouter(
      services.qualityProbeStore,
      services.wsSessionController,
    ),
  );
  app.use(
    "/api/diagnostic-logs",
    requireAuth,
    createDiagnosticLogsRouter(diagnosticLogRecorder),
  );
  app.use(
    "/api/terminal",
    requireAuth,
    createTerminalRouter(services.terminalSessionManager, {
      ptyService: services.ptyService,
      runtimeRegistry: services.terminalRuntimeRegistry,
      tmuxService: services.tmuxService,
      authService: services.authService,
      completionEventStore: services.terminalCompletionEventStore,
    }),
  );

  if (devtoolsEnabled) {
    app.use(
      "/devtools",
      createDevtoolsRouter({
        authService: services.authService,
        sessionManager: services.sessionManager,
      }),
    );
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
  authStore: AuthStore,
  sessionManager: SessionManager,
  terminalSessionManager: TerminalSessionManager,
  terminalRuntimeRegistry: TerminalRuntimeRegistry,
): void {
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    server.close();
    await terminalRuntimeRegistry.disposeAll();
    await terminalSessionManager.dispose();
    await sessionManager.dispose();
    await authStore.dispose();
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
    qualityProbeStore: services.qualityProbeStore,
    wsSessionController: services.wsSessionController,
  });
  attachTerminalWebSocketServer(
    server,
    services.terminalSessionManager,
    services.terminalRuntimeRegistry,
    services.authService,
    services.ptyService,
    services.tmuxService,
  );
  attachDevtoolsProxyServer(
    server,
    services.sessionManager,
    services.authService,
    {
      enabled: devtoolsEnabled,
    },
  );
  attachAiBridgeProxyServer(
    server,
    services.sessionManager,
    services.authService,
    {
      aiBridgeSessionController: services.aiBridgeSessionController,
    },
  );

  const port = await listenWithFallback(server, runtimeConfig.preferredPort, {
    host: runtimeConfig.host,
    maxAttempts: runtimeConfig.strictPort ? 1 : undefined,
  });
  process.env.RUNWEAVE_HOOK_ENDPOINT =
    process.env.RUNWEAVE_HOOK_ENDPOINT ??
    `http://127.0.0.1:${port}/internal/terminal-completion`;

  attachLifecycleHandlers(
    server,
    services.authStore,
    services.sessionManager,
    services.terminalSessionManager,
    services.terminalRuntimeRegistry,
  );
}

void startRuntime();
