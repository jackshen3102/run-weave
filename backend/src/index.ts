import "dotenv/config";
import http from "node:http";
import type { Socket } from "node:net";
import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import type { WebSocketServer } from "ws";
import { migrateLegacyBrowserProfileRootIfNeeded } from "@runweave/shared/browser-profile-node";
import { createRequireAuth } from "./auth/middleware";
import { initializeAppServerEventIntegration } from "./app-server/integration";
import { diagnosticLogRecorder } from "./diagnostic-logs/recorder";
import {
  createRequestContextMiddleware,
  flushAndCloseLogger,
  initializeLogger,
  logger,
} from "./logging";
import { createAuthRouter } from "./routes/auth";
import { createAppHomeOverviewRouter } from "./routes/app-home-overview";
import { createAppServerStateRouter } from "./routes/app-server-state";
import { createDiagnosticLogsRouter } from "./routes/diagnostic-logs";
import { createAgentTeamRouter } from "./routes/agent-team";
import { registerActivityRoutes } from "./routes/activity-registration";
import {
  createInternalTerminalAgentHookRouter,
  createTerminalStateRouter,
} from "./routes/terminal-state";
import { createInternalTerminalCompletionRouter } from "./routes/terminal-completion";
import { createTerminalRouter } from "./routes/terminal";
import { createTestRouter } from "./routes/test";
import { createPrototypePreviewRouter } from "./routes/prototype-preview";
import { createVoiceRouter } from "./routes/voice";
import { createWorkHistoryRouter } from "./routes/work-history";
import { createAttentionRouter } from "./routes/attention";
import { createEvolutionActivationRouter } from "./routes/evolution-activation";
import { createCorsMiddleware } from "./server/cors";
import { resolveFrontendDistDir } from "./server/frontend-dist";
import {
  isLocalDirectRequest,
  isValidLocalCdpEndpoint,
} from "./server/local-cdp-endpoint";
import { buildHealthPayload } from "./server/health";
import {
  createTunnelAuthMiddleware,
  createTunnelTokenBootstrapMiddleware,
  loadTunnelAuthConfig,
  type TunnelAuthConfig,
} from "./server/tunnel-auth";
import { TERMINAL_CLIPBOARD_IMAGE_JSON_LIMIT } from "./terminal/clipboard-image";
import { sanitizeCurrentTerminalProcessEnv } from "./terminal/env";
import { listenWithFallback } from "./server/listen";
import {
  acquireBackendProfileLock,
  type BackendProfileLock,
} from "./server/profile-lock";
import { resolveRuntimeConfig } from "./server/runtime-config";
import { resolveStoragePaths } from "./utils/path";
import { attachTerminalEventsWebSocketServer } from "./ws/terminal-events-server";
import { attachTerminalWebSocketServer } from "./ws/terminal-server";
import { codexAppServerClient } from "./voice/codex-app-server-client";
import {
  createRuntimeServices,
  type RuntimeServices,
} from "./bootstrap/runtime-services";

const HASHED_ASSET_CACHE_CONTROL =
  "public, max-age=31536000, s-maxage=31536000, immutable";
const REVALIDATED_STATIC_CACHE_CONTROL = "no-cache";

type BackendStartStage =
  | "runtime-config"
  | "storage-migration"
  | "profile-lock"
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

function parseConfiguredOrigins(rawOrigins: string | undefined): string[] {
  return (rawOrigins ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

sanitizeCurrentTerminalProcessEnv();

function createHttpApp(
  services: RuntimeServices,
  tunnelAuthConfig: TunnelAuthConfig | null,
  backendIdentity?: { backendId: string },
): express.Express {
  const app = express();
  const requireAuth = createRequireAuth(services.authService);
  const requireTunnelAuth = createTunnelAuthMiddleware(tunnelAuthConfig);

  app.use(createRequestContextMiddleware());
  app.use(express.json({ limit: TERMINAL_CLIPBOARD_IMAGE_JSON_LIMIT }));
  app.use(
    createCorsMiddleware(parseConfiguredOrigins(process.env.FRONTEND_ORIGIN)),
  );
  app.use(createTunnelTokenBootstrapMiddleware(tunnelAuthConfig));

  app.use(
    "/prototype-preview",
    requireTunnelAuth,
    createPrototypePreviewRouter(
      services.terminalSessionManager,
      services.authService,
    ),
  );

  app.get("/health", requireTunnelAuth, (_req, res) => {
    res.json(buildHealthPayload(process.env, backendIdentity));
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
      activity: services.terminalActivity,
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
  registerActivityRoutes(app, {
    services,
    requireAuth,
    requireTunnelAuth,
    backendInstanceId: backendIdentity?.backendId ?? `backend:${process.pid}`,
    hookToken: process.env.RUNWEAVE_HOOK_TOKEN,
  });

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
  diagnosticLogRecorder.configurePersistence({
    persistRoot: resolveStoragePaths(process.env).backendLogDir,
  });
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
    "/api/app-server",
    requireAuth,
    createAppServerStateRouter(services.appServerHistoryGateway),
  );
  app.use(
    "/api/work-history",
    requireAuth,
    createWorkHistoryRouter(services.workHistoryService),
  );
  app.use(
    "/api/attention",
    requireAuth,
    createAttentionRouter(services.attentionService),
  );
  app.use(
    "/api/agent-team",
    requireAuth,
    createAgentTeamRouter(services.agentTeamService),
  );
  app.use(
    "/api/evolution",
    requireAuth,
    createEvolutionActivationRouter(services.evolutionActivationStore),
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
      terminalEventService: services.terminalEventService,
      terminalStateService: services.terminalStateService,
      quickInputService: services.terminalQuickInputService,
      activity: services.terminalActivity,
    }),
  );
  app.use("/api/voice", requireAuth, createVoiceRouter());

  const frontendDistDir = resolveFrontendDistDir();
  if (existsSync(frontendDistDir)) {
    app.use(
      express.static(frontendDistDir, {
        setHeaders: setFrontendStaticHeaders,
      }),
    );

    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/ws")) {
        next();
        return;
      }

      res.setHeader("Cache-Control", REVALIDATED_STATIC_CACHE_CONTROL);
      res.sendFile(path.join(frontendDistDir, "index.html"));
    });
  }

  return app;
}

function setFrontendStaticHeaders(
  res: express.Response,
  filePath: string,
): void {
  const relativePath = filePath.split(path.sep).join("/");
  const fileName = path.basename(filePath);

  if (relativePath.includes("/assets/")) {
    res.setHeader("Cache-Control", HASHED_ASSET_CACHE_CONTROL);
    return;
  }

  if (
    fileName === "index.html" ||
    fileName === "manifest.webmanifest" ||
    fileName === "sw.js"
  ) {
    res.setHeader("Cache-Control", REVALIDATED_STATIC_CACHE_CONTROL);
  }
}

function attachLifecycleHandlers(
  server: http.Server,
  services: RuntimeServices,
  profileLock: BackendProfileLock,
  webSocketServers: WebSocketServer[],
  serverConnections: Set<Socket>,
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
      const serverClosed = closeServer(server);
      const webSocketServersClosed = Promise.all(
        webSocketServers.map(closeWebSocketServer),
      );
      for (const connection of serverConnections) {
        connection.destroy();
      }
      await webSocketServersClosed;
      await serverClosed;
      await services.tmuxOutputWatcher.dispose();
      services.appServerEventConsumer?.stop();
      await services.terminalRuntimeRegistry.disposeAll();
      for (const socketPath of new Set(
        services.tmuxSocketPathsToCleanOnShutdown,
      )) {
        await services.tmuxService.killServer(socketPath);
      }
      await services.terminalSessionManager.dispose();
      await services.terminalQuickInputStore.dispose();
      if (services.activityMaintenanceTimer) {
        clearInterval(services.activityMaintenanceTimer);
      }
      await services.activityStore?.close();
      await services.evolutionActivationStore.close();
      codexAppServerClient.shutdown();
      await services.authStore.dispose();
      await profileLock.release();
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

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    client.terminate();
  }
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
  let profileLock: BackendProfileLock | null = null;
  try {
    const runtimeConfig = resolveRuntimeConfig();
    stage = "storage-migration";
    const migration = await migrateLegacyBrowserProfileRootIfNeeded();
    if (migration.migrated.length > 0) {
      logger.info("backend.browserProfile.migrated", {
        component: "backend",
        legacyRoot: migration.legacyRoot,
        targetRoot: migration.targetRoot,
        profileIds: migration.migrated,
      });
    }
    const storagePaths = resolveStoragePaths(process.env);
    stage = "profile-lock";
    profileLock = await acquireBackendProfileLock({
      devSessionId: process.env.RUNWEAVE_DEV_SESSION_ID,
      profileDir: storagePaths.browserProfileDir,
      port: runtimeConfig.preferredPort,
      host: runtimeConfig.host,
      runtimeReleaseId: process.env.RUNWEAVE_RUNTIME_RELEASE_ID,
    });
    stage = "tunnel-auth-config";
    const tunnelAuthConfig = loadTunnelAuthConfig(process.env);
    stage = "runtime-services";
    const services = await createRuntimeServices();
    stage = "http-app";
    const app = createHttpApp(
      services,
      tunnelAuthConfig,
      profileLock.getOwner(),
    );
    const server = http.createServer(app);
    const serverConnections = new Set<Socket>();
    server.on("connection", (connection) => {
      serverConnections.add(connection);
      connection.once("close", () => serverConnections.delete(connection));
    });

    stage = "websocket-servers";
    const terminalWebSocketServer = attachTerminalWebSocketServer(
      server,
      services.terminalSessionManager,
      services.terminalRuntimeRegistry,
      services.authService,
      services.ptyService,
      services.tmuxService,
      {
        tunnelAuthConfig,
        tmuxOutputWatcher: services.tmuxOutputWatcher,
        tmuxLifecycleCoordinator: services.tmuxLifecycleCoordinator,
        terminalStateService: services.terminalStateService,
      },
    );
    const terminalEventsWebSocketServer = attachTerminalEventsWebSocketServer(
      server,
      services.authService,
      services.terminalEventService,
      { tunnelAuthConfig },
    );
    stage = "listen";
    const port = await listenWithFallback(server, runtimeConfig.preferredPort, {
      host: runtimeConfig.host,
      maxAttempts: runtimeConfig.strictPort ? 1 : undefined,
    });
    await profileLock.update({ port, host: runtimeConfig.host ?? null });
    const controlPlaneBaseUrl = `http://127.0.0.1:${port}`;
    // Pin rw CLI control-plane env to THIS backend. Parent shells may carry a
    // stale default such as 5001 while this process is running on a fallback
    // test port.
    process.env.RUNWEAVE_BASE_URL = controlPlaneBaseUrl;
    process.env.RUNWEAVE_BACKEND_PORT = String(port);
    // Always pin the hook endpoint to THIS backend's listening port. Inheriting
    // it from a parent shell spawned by another Runweave backend would deliver
    // codex hook events to the wrong process.
    process.env.RUNWEAVE_HOOK_ENDPOINT = `http://127.0.0.1:${port}/internal/terminal/agent-hook`;
    process.env.RUNWEAVE_COMPLETION_HOOK_ENDPOINT = `http://127.0.0.1:${port}/internal/terminal-completion`;
    await initializeAppServerEventIntegration(services, controlPlaneBaseUrl);

    stage = "lifecycle-handlers";
    attachLifecycleHandlers(
      server,
      services,
      profileLock,
      [terminalWebSocketServer, terminalEventsWebSocketServer],
      serverConnections,
    );
    logger.info("backend.started", {
      component: "backend",
      message: "Backend started",
      logDir: resolveStoragePaths(process.env).backendLogDir,
      host: runtimeConfig.host,
      port,
      runtimeReleaseId: process.env.RUNWEAVE_RUNTIME_RELEASE_ID?.trim() || null,
    });
  } catch (error) {
    await profileLock?.release();
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
