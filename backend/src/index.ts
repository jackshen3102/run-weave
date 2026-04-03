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
import { createDevtoolsRouter } from "./routes/devtools";
import { QualityProbeStore } from "./quality/probe-store";
import { createQualityRouter } from "./routes/quality";
import { createSessionRouter } from "./routes/session";
import { createTerminalRouter } from "./routes/terminal";
import { createTestRouter } from "./routes/test";
import { createCorsMiddleware } from "./server/cors";
import { SessionManager } from "./session/manager";
import { LowDbSessionStore } from "./session/lowdb-store";
import { TerminalSessionManager } from "./terminal/manager";
import { PtyService } from "./terminal/pty-service";
import { TerminalRuntimeRegistry } from "./terminal/runtime-registry";
import { LowDbTerminalSessionStore } from "./terminal/lowdb-store";
import { listenWithFallback } from "./server/listen";
import { resolveStoragePaths } from "./utils/path";
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
  authService: AuthService;
  sessionManager: SessionManager;
  browserService: BrowserService;
  qualityProbeStore: QualityProbeStore;
  wsSessionController: WebSocketSessionController;
  terminalSessionManager: TerminalSessionManager;
  terminalRuntimeRegistry: TerminalRuntimeRegistry;
  ptyService: PtyService;
}

const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const CURRENT_DIR_PATH = path.dirname(CURRENT_FILE_PATH);

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

function resolveSessionRestoreEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.SESSION_RESTORE_ENABLED?.trim().toLowerCase() === "true";
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
  const terminalRuntimeRegistry = new TerminalRuntimeRegistry();
  const ptyService = new PtyService();
  await sessionManager.initialize();
  await terminalSessionManager.initialize();

  return {
    authService,
    sessionManager,
    browserService,
    qualityProbeStore,
    wsSessionController,
    terminalSessionManager,
    terminalRuntimeRegistry,
    ptyService,
  };
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
    "/api/terminal",
    requireAuth,
    createTerminalRouter(services.terminalSessionManager, {
      ptyService: services.ptyService,
      runtimeRegistry: services.terminalRuntimeRegistry,
      authService: services.authService,
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
  );
  attachDevtoolsProxyServer(
    server,
    services.sessionManager,
    services.authService,
    {
      enabled: devtoolsEnabled,
    },
  );

  await listenWithFallback(server, runtimeConfig.preferredPort, {
    host: runtimeConfig.host,
    maxAttempts: runtimeConfig.strictPort ? 1 : undefined,
  });

  attachLifecycleHandlers(
    server,
    services.sessionManager,
    services.terminalSessionManager,
    services.terminalRuntimeRegistry,
  );
}

void startRuntime();
