import express, { type ErrorRequestHandler } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { parseArgs } from "node:util";
import path from "node:path";
import {
  resolveConfigurationContext,
  withConfigurationArguments,
} from "@runweave/config-node";
import { Backend } from "./backend.js";
import { Activity } from "./activity.js";
import { Evidence } from "./evidence.js";
import { Commands } from "./commands.js";
import { fileSources } from "./sources.js";
import { createMcp } from "./tools.js";
import { createMcpRuntimeStatus, mcpIdentity } from "./runtime-status.js";
import { runManagedTunnel } from "./tunnel-runner.js";

const { values } = parseArgs({
  options: {
    instance: { type: "string" },
    "config-dir": { type: "string" },
    profile: { type: "string" },
    port: { type: "string", default: "5099" },
    cwd: { type: "string" },
    "data-dir": { type: "string", multiple: true },
    help: { type: "boolean" },
    "tunnel-run": { type: "boolean" },
  },
});

async function main() {
  if (values["tunnel-run"]) { await runManagedTunnel(); return; }
  if (values.help) {
    console.log(
      "Runweave personal MCP: node /absolute/path/dist/index.cjs --instance stable --cwd /workspace [--port 5099] [--profile local] [--data-dir /extra/data]\nHTTP listens only on 127.0.0.1; connect tunnel-client to /mcp. Full host-account access; no additional data permissions.",
    );
    return;
  }
  const context = resolveConfigurationContext({ requireExplicit: true });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("port must be 1..65535");
  if (!values.cwd || !path.isAbsolute(values.cwd))
    throw new Error("--cwd must specify an absolute working directory");
  const baseUrl = `http://127.0.0.1:${port}`;
  const files = fileSources(
    values.cwd,
    (values["data-dir"] ?? []).map((p) => path.resolve(p)),
  );
  const backend = new Backend(values.profile);
  const evidence = new Evidence(baseUrl);
  const commands = await Commands.create(values.cwd);
  const activity = new Activity(backend, evidence);
  const runtimeStatus = createMcpRuntimeStatus(backend);
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    // A local full-access endpoint must not accept browser-origin shell requests.
    if (
      req.headers.origin ||
      ![`127.0.0.1:${port}`, `localhost:${port}`].includes(
        req.headers.host ?? "",
      )
    ) {
      res.status(403).json({ error: "local_transport_only" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.get("/health", (_req, res) =>
    res.json({
      service: "runweave-research-mcp",
      instance: context.instanceId,
      mcpUrl: `${baseUrl}/mcp`,
      ...mcpIdentity,
      pid: process.pid,
    }),
  );
  app.get("/runtime-status", (_req, res) => res.json(runtimeStatus.report()));
  app.get("/evidence/:id", (req, res) => {
    void evidence.fetch(String(req.params.id)).then(
      (document) => {
        res.set({
          "Content-Security-Policy":
            "default-src 'none'; frame-ancestors 'none'",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.type("text/plain").send(JSON.stringify(document, null, 2));
      },
      (error) => res.status(404).json({ error: String(error) }),
    );
  });
  const active = new Set<ReturnType<typeof createMcp>>();
  app.post("/mcp", (req, res, next) => {
    void withConfigurationArguments(process.argv.slice(2), async () => {
      const server = createMcp({
        backend,
        activity,
        commands,
        evidence,
        files,
        onToolSuccess: runtimeStatus.toolSucceeded,
      });
      active.add(server);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.once("close", () => {
        active.delete(server);
        void server.close().catch(() => undefined);
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        active.delete(server);
        await server.close();
        throw error;
      }
    }).catch(next);
  });
  app.all("/mcp", (_req, res) => res.set("Allow", "POST").status(405).end());
  const onError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(400).json({
      error: error instanceof Error ? error.message : "request_failed",
    });
  };
  app.use(onError);
  let listener: ReturnType<typeof app.listen>;
  try {
    listener = await new Promise<ReturnType<typeof app.listen>>(
      (resolve, reject) => {
        const http = app.listen(port, "127.0.0.1", () => resolve(http));
        http.once("error", reject);
      },
    );
  } catch (error) {
    await runtimeStatus.stop();
    await commands.close();
    throw error;
  }
  console.log(
    JSON.stringify({
      ready: true,
      url: `${baseUrl}/mcp`,
      instance: context.instanceId,
      cwd: values.cwd,
      ...mcpIdentity,
      pid: process.pid,
      time: new Date().toISOString(),
    }),
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    listener.close();
    await runtimeStatus.stop();
    await Promise.allSettled([...active].map((server) => server.close()));
    listener.closeAllConnections();
    await commands.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      console.log(JSON.stringify({ event: "mcp.stopping", signal, time: new Date().toISOString() }));
      void close();
    });
}

void withConfigurationArguments(process.argv.slice(2), main).catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
