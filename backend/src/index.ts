import "dotenv/config";
import http from "node:http";
import { existsSync } from "node:fs";
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
import {
  createRequestContextMiddleware,
  flushAndCloseLogger,
  initializeLogger,
  logger,
} from "./logging";
import { createAuthRouter } from "./routes/auth";
import { createAppHomeOverviewRouter } from "./routes/app-home-overview";
import { createDiagnosticLogsRouter } from "./routes/diagnostic-logs";
import { createDevtoolsRouter } from "./routes/devtools";
import { QualityProbeStore } from "./quality/probe-store";
import { createQualityRouter } from "./routes/quality";
import { createSessionRouter } from "./routes/session";
import {
  createInternalTerminalAgentHookRouter,
  createTerminalStateRouter,
} from "./routes/terminal-state";
import { createInternalTerminalCompletionRouter } from "./routes/terminal-completion";
import { createTerminalRouter } from "./routes/terminal";
import { createTestRouter } from "./routes/test";
import { createCorsMiddleware } from "./server/cors";
import { resolveFrontendDistDir } from "./server/frontend-dist";
import { buildHealthPayload } from "./server/health";
import {
  createTunnelAuthMiddleware,
  createTunnelTokenBootstrapMiddleware,
  loadTunnelAuthConfig,
  type TunnelAuthConfig,
} from "./server/tunnel-auth";
import { SessionManager } from "./session/manager";
import { TERMINAL_CLIPBOARD_IMAGE_JSON_LIMIT } from "./terminal/clipboard-image";
import { LowDbSessionStore } from "./session/lowdb-store";
import { TerminalSessionManager } from "./terminal/manager";
import { TerminalCompletionEventService } from "./terminal/completion-event-service";
import { TerminalCompletionEventStore } from "./terminal/completion-events";
import { TerminalStateService } from "./terminal/terminal-state-service";
import { TerminalStateStore } from "./terminal/terminal-state-store";
import { loadOrCreateHookToken } from "./terminal/hook-token";
import { PtyService } from "./terminal/pty-service";
import { TerminalRuntimeRegistry } from "./terminal/runtime-registry";
import { TmuxOutputWatcher } from "./terminal/tmux-output-watcher";
import { TmuxService } from "./terminal/tmux-service";
import { sanitizeCurrentTerminalProcessEnv } from "./terminal/env";
import { LowDbTerminalSessionStore } from "./terminal/lowdb-store";
import { logOrphanedTmuxSessions } from "./terminal/tmux-orphan-scan";
import { listenWithFallback } from "./server/listen";
import { resolveStoragePaths } from "./utils/path";
import { attachDevtoolsProxyServer } from "./ws/devtools-proxy";
import { WebSocketSessionController } from "./ws/session-control";
import { attachTerminalEventsWebSocketServer } from "./ws/terminal-events-server";
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
  terminalSessionManager: TerminalSessionManager;
  terminalStateService: TerminalStateService;
  terminalCompletionEventService: TerminalCompletionEventService;
  terminalRuntimeRegistry: TerminalRuntimeRegistry;
  ptyService: PtyService;
  tmuxService: TmuxService;
  tmuxOutputWatcher: TmuxOutputWatcher;
}

const LOCAL_ONLY_FORWARDED_HEADER_NAMES = [
  "cf-connecting-ip",
  "cf-ray",
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
] as const;

type BackendStartStage =
  | "runtime-config"
  | "tunnel-auth-config"
  | "runtime-services"
  | "http-app"
  | "websocket-servers"
  | "listen"
  | "lifecycle-handlers";

class BackendStartError extends Error {
  constructor(
    readonly stage: BackendStartStage,
    readonly originalError: unknown,
  ) {
    super(`Backend start failed during ${stage}`);
    this.name = "BackendStartError";
  }
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

function hasForwardedHeaders(req: express.Request): boolean {
  return LOCAL_ONLY_FORWARDED_HEADER_NAMES.some(
    (headerName) => req.headers[headerName] !== undefined,
  );
}

function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function isLocalDirectRequest(req: express.Request): boolean {
  return (
    isLoopbackAddress(req.socket.remoteAddress) && !hasForwardedHeaders(req)
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost"
  );
}

function isValidLocalCdpEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    return (
      parsed.protocol === "http:" &&
      isLoopbackHostname(parsed.hostname) &&
      parsed.port !== "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function resolveSessionRestoreEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.SESSION_RESTORE_ENABLED?.trim().toLowerCase() === "true";
}

function resolveTerminalHookToken(
  env: NodeJS.ProcessEnv,
  tokenFilePath: string,
): string {
  const existing = env.RUNWEAVE_HOOK_TOKEN?.trim();
  if (existing) {
    return existing;
  }

  // Persist the generated token so existing tmux panes continue to
  // authenticate against the new backend after a restart / app upgrade.
  return loadOrCreateHookToken(tokenFilePath);
}

sanitizeCurrentTerminalProcessEnv();

function resolveTerminalTmuxScanOrphansOnStartEnabled(
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    env.TERMINAL_TMUX_SCAN_ORPHANS_ON_START?.trim().toLowerCase() === "true" ||
    env.TERMINAL_TMUX_CLEANUP_ORPHANS?.trim().toLowerCase() === "true"
  );
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
  const sessionManager = new SessionManager(browserService, sessionStore, {
    restorePersistedSessions: resolveSessionRestoreEnabled(process.env),
    qualityProbeStore,
  });
  const terminalSessionManager = new TerminalSessionManager(
    terminalSessionStore,
  );
  const terminalStateService = new TerminalStateService(
    new TerminalStateStore(),
  );
  const terminalCompletionEventStore = new TerminalCompletionEventStore();
  const terminalCompletionEventService = new TerminalCompletionEventService(
    terminalCompletionEventStore,
  );
  const terminalRuntimeRegistry = new TerminalRuntimeRegistry();
  process.env.RUNWEAVE_HOOK_TOKEN = resolveTerminalHookToken(
    process.env,
    path.join(storagePaths.browserProfileDir, "runweave-hook-token"),
  );
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
  const tmuxOutputWatcher = new TmuxOutputWatcher({
    outputDir: path.join(
      path.dirname(storagePaths.terminalSessionStoreFile),
      "tmux-output",
    ),
    terminalSessionManager,
    tmuxService,
  });
  await sessionManager.initialize();
  await terminalSessionManager.initialize();
  if (resolveTerminalTmuxScanOrphansOnStartEnabled(process.env)) {
    await logOrphanedTmuxSessions(terminalSessionManager, tmuxService);
  }
  await tmuxOutputWatcher.watchExistingSessions();

  return {
    authStore,
    authService,
    authCookieName: authConfig.refreshCookieName,
    authSecureCookies: authConfig.secureCookies,
    sessionManager,
    browserService,
    qualityProbeStore,
    wsSessionController,
    terminalSessionManager,
    terminalStateService,
    terminalCompletionEventService,
    terminalRuntimeRegistry,
    ptyService,
    tmuxService,
    tmuxOutputWatcher,
  };
}

function createHttpApp(
  services: RuntimeServices,
  tunnelAuthConfig: TunnelAuthConfig | null,
): express.Express {
  const app = express();
  const requireAuth = createRequireAuth(services.authService);
  const requireTunnelAuth = createTunnelAuthMiddleware(tunnelAuthConfig);
  const devtoolsEnabled = services.sessionManager.isDevtoolsEnabled();

  app.use(createRequestContextMiddleware());
  app.use(express.json({ limit: TERMINAL_CLIPBOARD_IMAGE_JSON_LIMIT }));
  app.use(
    createCorsMiddleware(parseConfiguredOrigins(process.env.FRONTEND_ORIGIN)),
  );
  app.use(createTunnelTokenBootstrapMiddleware(tunnelAuthConfig));

  app.get("/health", requireTunnelAuth, (_req, res) => {
    res.json(buildHealthPayload(process.env));
  });

  // Internal endpoint for Electron to propagate CDP proxy endpoint in dev mode.
  // In production, the env is inherited via child process spawn.
  app.put("/internal/cdp-endpoint", requireTunnelAuth, (req, res) => {
    if (!isLocalDirectRequest(req)) {
      res.status(403).json({ error: "Local request required" });
      return;
    }

    const { endpoint } = req.body as { endpoint?: string };
    if (typeof endpoint !== "string" || !isValidLocalCdpEndpoint(endpoint)) {
      res.status(400).json({ error: "valid local endpoint required" });
      return;
    }

    process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT = endpoint;
    logger.info("backend.cdp-endpoint.updated", {
      component: "backend",
      message: "CDP endpoint set via internal API",
      endpoint,
    });
    res.json({ ok: true });
  });

  app.use(
    "/internal/terminal/agent-hook",
    requireTunnelAuth,
    createInternalTerminalAgentHookRouter({
      terminalSessionManager: services.terminalSessionManager,
      terminalStateService: services.terminalStateService,
      hookToken: process.env.RUNWEAVE_HOOK_TOKEN,
    }),
  );
  app.use(
    "/internal/terminal-completion",
    requireTunnelAuth,
    createInternalTerminalCompletionRouter({
      completionEventService: services.terminalCompletionEventService,
      terminalSessionManager: services.terminalSessionManager,
      hookToken: process.env.RUNWEAVE_HOOK_TOKEN,
    }),
  );

  if (process.env.RUNWEAVE_E2E_TEST_ROUTES === "true") {
    app.use("/test", createTestRouter());
  }
  app.use("/test", (_req, res) => {
    res.status(404).json({ message: "Not found" });
  });
  app.use("/api", requireTunnelAuth);
  app.use(
    "/api/auth",
    createAuthRouter(services.authService, {
      refreshCookieName: services.authCookieName,
      secureCookies: services.authSecureCookies,
      trustProxyHeaders: tunnelAuthConfig !== null,
    }),
  );
  app.use(
    "/api",
    requireAuth,
    createSessionRouter(services.sessionManager, services.authService),
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
    "/api/app",
    requireAuth,
    createAppHomeOverviewRouter({
      terminalSessionManager: services.terminalSessionManager,
      terminalStateService: services.terminalStateService,
    }),
  );
  app.use(
    "/api/terminal",
    requireAuth,
    createTerminalStateRouter({
      terminalSessionManager: services.terminalSessionManager,
      terminalStateService: services.terminalStateService,
      tmuxService: services.tmuxService,
    }),
  );
  app.use(
    "/api/terminal",
    requireAuth,
    createTerminalRouter(services.terminalSessionManager, {
      ptyService: services.ptyService,
      runtimeRegistry: services.terminalRuntimeRegistry,
      tmuxService: services.tmuxService,
      tmuxOutputWatcher: services.tmuxOutputWatcher,
      authService: services.authService,
      completionEventService: services.terminalCompletionEventService,
    }),
  );

  if (devtoolsEnabled) {
    app.use(
      "/devtools",
      requireTunnelAuth,
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
  services: RuntimeServices,
): void {
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("backend.shutdown.started", {
      component: "backend",
      message: "Backend shutdown started",
    });
    try {
      await closeServer(server);
      await services.tmuxOutputWatcher.dispose();
      await services.terminalRuntimeRegistry.disposeAll();
      await services.terminalSessionManager.dispose();
      await services.sessionManager.dispose();
      await services.authStore.dispose();
      logger.info("backend.shutdown.completed", {
        component: "backend",
        message: "Backend shutdown completed",
      });
      await flushAndCloseLogger();
      process.exit(0);
    } catch (error) {
      logger.error("backend.shutdown.failed", {
        component: "backend",
        message: "Backend shutdown failed",
        error,
      });
      await flushAndCloseLogger();
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    void shutdown();
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function startRuntime(): Promise<void> {
  let stage: BackendStartStage = "runtime-config";
  try {
    const runtimeConfig = resolveRuntimeConfig();
    stage = "tunnel-auth-config";
    const tunnelAuthConfig = loadTunnelAuthConfig(process.env);
    stage = "runtime-services";
    const services = await createRuntimeServices();
    stage = "http-app";
    const app = createHttpApp(services, tunnelAuthConfig);
    const server = http.createServer(app);

    const devtoolsEnabled = services.sessionManager.isDevtoolsEnabled();

    stage = "websocket-servers";
    attachWebSocketServer(
      server,
      services.sessionManager,
      services.authService,
      {
        devtoolsEnabled,
        qualityProbeStore: services.qualityProbeStore,
        wsSessionController: services.wsSessionController,
        tunnelAuthConfig,
      },
    );
    attachTerminalWebSocketServer(
      server,
      services.terminalSessionManager,
      services.terminalRuntimeRegistry,
      services.authService,
      services.ptyService,
      services.tmuxService,
      {
        tunnelAuthConfig,
        tmuxOutputWatcher: services.tmuxOutputWatcher,
        terminalStateService: services.terminalStateService,
      },
    );
    attachTerminalEventsWebSocketServer(
      server,
      services.authService,
      services.terminalCompletionEventService,
      { tunnelAuthConfig },
    );
    attachDevtoolsProxyServer(
      server,
      services.sessionManager,
      services.authService,
      {
        enabled: devtoolsEnabled,
        tunnelAuthConfig,
      },
    );
    stage = "listen";
    const port = await listenWithFallback(server, runtimeConfig.preferredPort, {
      host: runtimeConfig.host,
      maxAttempts: runtimeConfig.strictPort ? 1 : undefined,
    });
    // Always pin the hook endpoint to THIS backend's listening port. Inheriting
    // it from a parent shell spawned by another Runweave backend would deliver
    // codex hook events to the wrong process.
    process.env.RUNWEAVE_HOOK_ENDPOINT = `http://127.0.0.1:${port}/internal/terminal/agent-hook`;
    process.env.RUNWEAVE_COMPLETION_HOOK_ENDPOINT = `http://127.0.0.1:${port}/internal/terminal-completion`;

    stage = "lifecycle-handlers";
    attachLifecycleHandlers(server, services);
    logger.info("backend.started", {
      component: "backend",
      message: "Backend started",
      logDir: resolveStoragePaths(process.env).backendLogDir,
      host: runtimeConfig.host,
      port,
      runtimeReleaseId: process.env.RUNWEAVE_RUNTIME_RELEASE_ID?.trim() || null,
    });
  } catch (error) {
    throw new BackendStartError(stage, error);
  }
}

const loggerState = initializeLogger({ env: process.env });
logger.debug("backend.logger.initialized", {
  component: "backend",
  logDir: loggerState.logDir,
  logToFile: loggerState.logToFile,
});

startRuntime().catch(async (error: unknown) => {
  const startError =
    error instanceof BackendStartError
      ? error
      : new BackendStartError("runtime-config", error);
  logger.error("backend.start.failed", {
    component: "backend",
    message: "Backend start failed",
    stage: startError.stage,
    error: startError.originalError,
  });
  await flushAndCloseLogger();
  process.exitCode = 1;
});
