import http from "node:http";
import express from "express";
import { BrowserService } from "./browser/service";
import { createSessionRouter } from "./routes/session";
import { SessionManager } from "./session/manager";
import { attachWebSocketServer } from "./ws/server";

const port = Number(process.env.PORT ?? 3000);

const app = express();
app.use(express.json());

const allowedOrigins = new Set([
  process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
  "http://127.0.0.1:5173",
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

const browserService = new BrowserService();
const sessionManager = new SessionManager(browserService);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", createSessionRouter(sessionManager));

const server = http.createServer(app);
attachWebSocketServer(server, sessionManager);

server.listen(port, () => {
  console.log(`backend listening on http://localhost:${port}`);
});

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
