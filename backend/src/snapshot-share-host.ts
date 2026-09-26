import { settingText, configuration, acquireConfigurationOwner } from "@runweave/config-node";
import express from "express";
import path from "node:path";
import { createServer } from "node:http";
import { createPublicTerminalSnapshotShareRouter } from "./routes/terminal-snapshot-share";
import { createTerminalSnapshotUploadRouter } from "./routes/terminal-snapshot-upload";
import { TerminalSnapshotHostService } from "./terminal/snapshot-share/host-service";
import { TerminalSnapshotShareStore } from "./terminal/snapshot-share/store";

async function main(): Promise<void> {
  configuration().requireDomain("services.snapshotHost");
  const token = settingText("services.snapshotHost.uploadToken");
  const directory = settingText("services.snapshotHost.directory");
  const port = Number(settingText("services.snapshotHost.port") ?? "8093");
  if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token) || !directory || !path.isAbsolute(directory) ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid snapshot host configuration");
  }
  const owner = acquireConfigurationOwner(configuration().context, "snapshot-host");
  const service = new TerminalSnapshotHostService(new TerminalSnapshotShareStore(directory));
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  let ready = false;
  app.use((_req, res, next) => { if (!ready) res.status(503).end(); else next(); });
  app.get("/health", (_req, res) => { res.json({ ok: true, environment: configuration().context }); });
  app.use("/share/terminal", createPublicTerminalSnapshotShareRouter(service));
  app.use("/api/snapshot-shares", createTerminalSnapshotUploadRouter(service, token));
  app.use((_req, res) => { res.status(404).end(); });
  const errorHandler: express.ErrorRequestHandler = (error, _req, res, _next) => {
    void _next; // Express recognizes error middleware by its four-argument signature.
    if (res.headersSent) { res.destroy(); return; }
    res.status(error?.type === "entity.too.large" ? 413 : 400).json({ message: "Invalid request" });
  };
  app.use(errorHandler);
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, app);
  // Bind first: another process must not clean or mutate the same store before failing to bind.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  try {
    await service.initialize();
    ready = true;
  } catch (error) {
    server.close();
    await service.dispose();
    throw error;
  }
  console.log(`Snapshot host listening on 127.0.0.1:${port}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    ready = false;
    const drained = new Promise<void>((resolve) => { server.close(() => resolve()); });
    const deadline = setTimeout(() => server.closeAllConnections(), 35_000);
    deadline.unref();
    await drained;
    await service.dispose();
    clearTimeout(deadline);
    owner.release();
  };
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
}

void main().catch(() => {
  // Configuration errors must not leak upload tokens or signed URLs to logs.
  console.error("Snapshot host startup failed");
  process.exitCode = 1;
});
