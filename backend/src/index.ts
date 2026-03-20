import http from "node:http";
import express from "express";
import { BrowserService } from "./browser/service";
import { createSessionRouter } from "./routes/session";
import { SessionManager } from "./session/manager";
import { listenWithFallback } from "./server/listen";
import { attachWebSocketServer } from "./ws/server";

const preferredPort = Number(process.env.PORT ?? 5001);

const app = express();
app.use(express.json());

const configuredOrigins = (process.env.FRONTEND_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  ...configuredOrigins,
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
});

const browserService = new BrowserService({
  headless: process.env.BROWSER_HEADLESS?.trim().toLowerCase() !== "false",
  profileDir: process.env.BROWSER_PROFILE_DIR,
});
const sessionManager = new SessionManager(browserService);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/test/popup", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Popup Source</title>
    <style>
      body { margin: 0; font-family: sans-serif; background: #f2f4f8; }
      #open {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin: 20px;
        width: 280px;
        height: 100px;
        font-size: 18px;
        text-decoration: none;
        color: #111827;
        border: 1px solid #9ca3af;
        border-radius: 8px;
        background: #e5e7eb;
      }
    </style>
  </head>
  <body>
    <a id="open" href="/test/child" target="_blank" rel="noopener noreferrer">
      Open Child Tab
    </a>
  </body>
</html>`);
});

app.get("/test/popup-auto", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Popup Auto Source</title>
  </head>
  <body>
    <h1>Popup Auto Source</h1>
    <script>
      window.open("/test/child", "_blank", "noopener,noreferrer");
    </script>
  </body>
</html>`);
});

app.get("/test/child", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Popup Child</title>
  </head>
  <body>
    <h1>Popup Child</h1>
    <p>Opened from source page.</p>
  </body>
</html>`);
});

app.use("/api", createSessionRouter(sessionManager));

const server = http.createServer(app);
attachWebSocketServer(server, sessionManager);

const startServer = async (): Promise<void> => {
  const port = await listenWithFallback(server, preferredPort);
  if (port !== preferredPort) {
    console.log(
      `[viewer-be] preferred port ${preferredPort} is busy, switched to ${port}`,
    );
  }

  console.log(`backend listening on http://localhost:${port}`);
};

void startServer();

const shutdown = async (): Promise<void> => {
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
