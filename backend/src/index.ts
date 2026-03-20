import "dotenv/config";
import http from "node:http";
import express from "express";
import { BrowserService } from "./browser/service";
import { loadAuthConfig } from "./auth/config";
import { createRequireAuth } from "./auth/middleware";
import { AuthService } from "./auth/service";
import { createAuthRouter } from "./routes/auth";
import { createSessionRouter } from "./routes/session";
import { createTestRouter } from "./routes/test";
import { createCorsMiddleware } from "./server/cors";
import { SessionManager } from "./session/manager";
import { listenWithFallback } from "./server/listen";
import { attachWebSocketServer } from "./ws/server";

interface RuntimeConfig {
  preferredPort: number;
  strictPort: boolean;
  host: string | undefined;
}

interface RuntimeServices {
  authService: AuthService;
  sessionManager: SessionManager;
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

function createRuntimeServices(): RuntimeServices {
  const browserService = new BrowserService({
    headless: process.env.BROWSER_HEADLESS?.trim().toLowerCase() !== "false",
    profileDir: process.env.BROWSER_PROFILE_DIR,
  });
  const authService = new AuthService(loadAuthConfig());
  const sessionManager = new SessionManager(browserService);

  return { authService, sessionManager };
}

function createHttpApp(services: RuntimeServices): express.Express {
  const app = express();
  const requireAuth = createRequireAuth(services.authService);

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
  const services = createRuntimeServices();
  const app = createHttpApp(services);
  const server = http.createServer(app);

  attachWebSocketServer(server, services.sessionManager, services.authService);

  const port = await listenWithFallback(server, runtimeConfig.preferredPort, {
    host: runtimeConfig.host,
    maxAttempts: runtimeConfig.strictPort ? 1 : undefined,
  });

  if (port !== runtimeConfig.preferredPort) {
    console.log(
      `[viewer-be] preferred port ${runtimeConfig.preferredPort} is busy, switched to ${port}`,
    );
  }

  const publicHost = runtimeConfig.host === "0.0.0.0" ? "localhost" : runtimeConfig.host;
  console.log(`backend listening on http://${publicHost ?? "localhost"}:${port}`);

  attachLifecycleHandlers(server, services.sessionManager);
}

void startRuntime();
