import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.dirname(path.dirname(SCRIPT_PATH));
const backendRequire = createRequire(
  path.join(REPO_ROOT, "backend", "package.json"),
);
const { WebSocket, WebSocketServer } = backendRequire("ws");
const TSX_CLI_PATH = backendRequire.resolve("tsx/cli");
const checks = [];

function check(name, condition, details) {
  assert.ok(condition, `${name}: ${JSON.stringify(details)}`);
  checks.push(name);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Condition did not settle within ${timeoutMs}ms`);
}

async function runServiceFixture() {
  const variantIndex = process.argv.indexOf("--variant");
  const variant = variantIndex >= 0 ? process.argv[variantIndex + 1] : "a";
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  await appendFile(
    path.join(process.cwd(), "workspace-service-processes.jsonl"),
    `${JSON.stringify({ pid: process.pid, childPid: child.pid, variant })}\n`,
  );
  const server = http.createServer(async (request, response) => {
    if (request.url === "/health") {
      response.end("ok");
      return;
    }
    if (request.url === "/stream") {
      response.write("one-");
      setTimeout(() => response.end("two"), 25);
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        body: Buffer.concat(chunks).toString("utf8"),
        forwardedFor: request.headers["x-forwarded-for"],
        forwardedHost: request.headers["x-forwarded-host"],
        host: request.headers.host,
        method: request.method,
        projectId: process.env.RUNWEAVE_PROJECT_ID,
        targetPort: Number(process.env.RUNWEAVE_SERVICE_PORT),
        url: request.url,
        variant,
      }),
    );
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit("connection", client, request);
    });
  });
  wss.on("connection", (client) => {
    client.on("message", (message) => client.send(message));
  });
  server.listen(Number(process.env.RUNWEAVE_SERVICE_PORT), "127.0.0.1");
  await once(server, "listening");
}

function createManagerFixture(root, contextEntries, WorkspaceServiceManager) {
  const contexts = new Map(contextEntries);
  const terminalSessionManager = {
    getProjectContext(projectId) {
      return contexts.get(projectId);
    },
    listProjects() {
      return [{ id: "project-fixture", name: "Fixture Project" }];
    },
  };
  return new WorkspaceServiceManager(terminalSessionManager);
}

function buildContext(projectId, name, contextPath) {
  return {
    availability: "available",
    isPrimary: projectId === "project-fixture",
    name,
    parentProjectId: "project-fixture",
    path: contextPath,
    projectId,
  };
}

function buildConfig(variant = "a") {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      services: {
        web: {
          command: `${shellQuote(process.execPath)} ${shellQuote(SCRIPT_PATH)} --service-fixture --variant ${variant}`,
          healthCheck: { path: "/health" },
        },
      },
    },
    null,
    2,
  )}\n`;
}

async function git(cwd, args) {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function createGitContexts(root) {
  await git(root, ["init", "-b", "main"]);
  await writeFile(path.join(root, "README.md"), "fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, [
    "-c",
    "user.name=Runweave Fixture",
    "-c",
    "user.email=fixture@runweave.local",
    "commit",
    "-m",
    "fixture",
  ]);
  const worktreeA = path.join(path.dirname(root), `${path.basename(root)}-wt-a`);
  const worktreeB = path.join(path.dirname(root), `${path.basename(root)}-wt-b`);
  await git(root, ["worktree", "add", "-b", "fixture/wt-a", worktreeA]);
  await git(root, ["worktree", "add", "-b", "fixture/wt-b", worktreeB]);
  return [
    ["project-fixture", buildContext("project-fixture", "main", root)],
    ["context-wt-a", buildContext("context-wt-a", "wt-a", worktreeA)],
    ["context-wt-b", buildContext("context-wt-b", "wt-b", worktreeB)],
  ];
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function request(port, requestPath, options = {}) {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            status: response.statusCode,
          }),
        );
      },
    );
    req.once("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function verifyWebSocket(port, host) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal`, {
    headers: { Host: host },
  });
  await once(socket, "open");
  const received = [];
  socket.on("message", (message) => received.push(String(message)));
  for (let index = 0; index < 100; index += 1) {
    socket.send(`message-${index}`);
  }
  await waitUntil(() => received.length === 100);
  socket.close();
  check(
    "workspace-websocket-preserves-message-order",
    received.every((message, index) => message === `message-${index}`),
    received.slice(0, 5),
  );
}

async function waitForStatus(manager, projectId, status) {
  return await waitUntil(async () => {
    const response = await manager.list("project-fixture", projectId);
    const service = response.services.find((candidate) => candidate.name === "web");
    return service?.status === status ? service : null;
  }, 35_000);
}

async function readOwnedPids(contextPath) {
  const content = await readFile(
    path.join(contextPath, "workspace-service-processes.jsonl"),
    "utf8",
  );
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runCrashHarness(contextPath) {
  const { WorkspaceServiceManager } = await import(
    "../backend/src/terminal/workspace-service/manager.ts"
  );
  const contextEntries = [
    ["project-fixture", buildContext("project-fixture", "main", contextPath)],
  ];
  const manager = createManagerFixture(
    contextPath,
    contextEntries,
    WorkspaceServiceManager,
  );
  manager.setProxyPort(49_999);
  const listed = await manager.list("project-fixture", "project-fixture");
  await manager.start({
    parentProjectId: "project-fixture",
    projectId: "project-fixture",
    serviceName: "web",
    configRevision: listed.config.revision,
  });
  await waitForStatus(manager, "project-fixture", "ready");
  const owned = (await readOwnedPids(contextPath)).at(-1);
  process.stdout.write(
    `CRASH_READY ${JSON.stringify({ ...owned, harnessPid: process.pid })}\n`,
  );
  await new Promise(() => {});
}

async function verifyCrashCleanup(contextPath) {
  const child = spawn(
    process.execPath,
    [
      TSX_CLI_PATH,
      SCRIPT_PATH,
      "--crash-harness",
      contextPath,
    ],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  let owned;
  try {
    owned = await waitUntil(() => {
    const line = stdout
      .split("\n")
      .find((candidate) => candidate.startsWith("CRASH_READY "));
    return line ? JSON.parse(line.slice("CRASH_READY ".length)) : null;
    }, 35_000).catch((error) => {
      throw new Error(`${error.message}; crash harness stderr: ${stderr}`);
    });
    process.kill(owned.harnessPid, "SIGKILL");
    await waitUntil(
      () => !processIsAlive(owned.pid) && !processIsAlive(owned.childPid),
      5_000,
    );
    check(
      "ipc-disconnect-reclaims-service-process-group",
      !processIsAlive(owned.pid) && !processIsAlive(owned.childPid),
      owned,
    );
  } finally {
    if (owned?.harnessPid && processIsAlive(owned.harnessPid)) {
      process.kill(owned.harnessPid, "SIGKILL");
    }
    if (owned?.pid && processIsAlive(owned.pid)) {
      try {
        process.kill(-owned.pid, "SIGKILL");
      } catch {
        // The process group may exit between the liveness check and cleanup.
      }
    }
    if (processIsAlive(child.pid)) child.kill("SIGKILL");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }
}

async function main() {
  const expressModule = backendRequire("express");
  const express = expressModule.default ?? expressModule;
  const { WorkspaceServiceManager } = await import(
    "../backend/src/terminal/workspace-service/manager.ts"
  );
  const { createWorkspaceServiceHttpProxy, attachWorkspaceServiceUpgradeProxy } =
    await import("../backend/src/terminal/workspace-service/proxy.ts");
  const { registerTerminalWorkspaceServiceRoutes } = await import(
    "../backend/src/routes/terminal-workspace-service-routes.ts"
  );
  const { createHttpUpgradeRouter } = await import(
    "../backend/src/server/http-upgrade-router.ts"
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "runweave-services-"));
  let server;
  let externalProcess;
  try {
    const contextEntries = await createGitContexts(root);
    for (const [, context] of contextEntries) {
      await writeFile(path.join(context.path, "runweave.json"), buildConfig());
    }
    const manager = createManagerFixture(root, contextEntries, WorkspaceServiceManager);
    const app = express();
    app.use(createWorkspaceServiceHttpProxy(manager));
    app.use(express.json());
    const router = express.Router();
    registerTerminalWorkspaceServiceRoutes(router, manager);
    app.use("/api/terminal", router);
    app.use((_request, response) => response.status(418).send("fallback"));
    server = http.createServer(app);
    const upgradeRouter = createHttpUpgradeRouter(server);
    attachWorkspaceServiceUpgradeProxy(upgradeRouter, manager);
    const proxyPort = await listen(server);
    manager.setProxyPort(proxyPort);

    const initialLists = await Promise.all(
      contextEntries.map(([projectId]) =>
        manager.list("project-fixture", projectId),
      ),
    );
    const urls = initialLists.map((item) => item.services[0]?.url);
    check(
      "config-discovery-is-stopped-and-context-scoped",
      initialLists.every(
        (item) => item.config.status === "valid" && item.services[0]?.status === "stopped",
      ) && new Set(urls).size === 3,
      urls,
    );

    const mainConfigPath = path.join(root, "runweave.json");
    const staleRevision = initialLists[0].config.revision;
    await writeFile(mainConfigPath, buildConfig("b"));
    await assert.rejects(
      manager.start({
        parentProjectId: "project-fixture",
        projectId: "project-fixture",
        serviceName: "web",
        configRevision: staleRevision,
      }),
      (error) => error?.code === "config_changed",
    );
    await writeFile(mainConfigPath, buildConfig());
    check("stale-config-revision-fails-closed", true, {});

    const currentLists = await Promise.all(
      contextEntries.map(([projectId]) =>
        manager.list("project-fixture", projectId),
      ),
    );
    await Promise.all(
      contextEntries.map(([projectId], contextIndex) =>
        Promise.all(
          Array.from({ length: 20 }, () =>
            manager.start({
              parentProjectId: "project-fixture",
              projectId,
              serviceName: "web",
              configRevision: currentLists[contextIndex].config.revision,
            }),
          ),
        ),
      ),
    );
    const readyServices = await Promise.all(
      contextEntries.map(([projectId]) => waitForStatus(manager, projectId, "ready")),
    );
    for (const [, context] of contextEntries) {
      const starts = await readOwnedPids(context.path);
      check("concurrent-start-creates-one-process", starts.length === 1, starts);
    }

    for (let contextIndex = 0; contextIndex < contextEntries.length; contextIndex += 1) {
      const [projectId] = contextEntries[contextIndex];
      const service = readyServices[contextIndex];
      const parsed = new URL(service.url);
      for (let requestIndex = 0; requestIndex < 100; requestIndex += 1) {
        const response = await request(proxyPort, `/inspect?request=${requestIndex}`, {
          headers: { Host: parsed.host },
        });
        const payload = JSON.parse(response.body);
        assert.equal(payload.projectId, projectId);
        assert.equal(payload.host, parsed.host);
      }
    }
    check("three-contexts-do-not-cross-route-in-300-requests", true, urls);

    const primary = readyServices[0];
    const primaryHost = new URL(primary.url).host;
    const post = await request(proxyPort, "/inspect?mode=post", {
      method: "POST",
      headers: {
        Host: primaryHost,
        "Content-Type": "text/plain",
        "Content-Length": "7",
      },
      body: "payload",
    });
    const postPayload = JSON.parse(post.body);
    check(
      "http-proxy-preserves-request-and-trusted-forwarding",
      post.status === 200 &&
        postPayload.body === "payload" &&
        postPayload.method === "POST" &&
        postPayload.forwardedFor === "127.0.0.1" &&
        postPayload.forwardedHost === primaryHost,
      postPayload,
    );
    const stream = await request(proxyPort, "/stream", {
      headers: { Host: primaryHost },
    });
    check("http-proxy-preserves-streaming-body", stream.body === "one-two", stream);
    const unknown = await request(proxyPort, "/", {
      headers: {
        Host: `web--unknown--fixture-aaaaaaaaaaaa.localhost:${proxyPort}`,
      },
    });
    check("unknown-workspace-host-does-not-fall-through", unknown.status === 404, unknown);
    const forwarded = await request(proxyPort, "/", {
      headers: { Host: primaryHost, "X-Forwarded-For": "127.0.0.1" },
    });
    check("forwarded-workspace-request-is-rejected", forwarded.status === 403, forwarded);
    await verifyWebSocket(proxyPort, primaryHost);

    const apiPath =
      "/api/terminal/project/project-fixture/contexts/project-fixture/services";
    const rejectedApi = await request(proxyPort, apiPath, {
      headers: { "X-Forwarded-For": "127.0.0.1" },
    });
    check("forwarded-control-api-is-rejected", rejectedApi.status === 403, rejectedApi);

    const originalUrl = primary.url;
    const originalPort = primary.targetPort;
    await manager.stop({
      parentProjectId: "project-fixture",
      projectId: "project-fixture",
      serviceName: "web",
    });
    const portLease = http.createServer();
    portLease.listen(originalPort, "127.0.0.1");
    await once(portLease, "listening");
    const restartList = await manager.list("project-fixture", "project-fixture");
    await manager.start({
      parentProjectId: "project-fixture",
      projectId: "project-fixture",
      serviceName: "web",
      configRevision: restartList.config.revision,
    });
    const restarted = await waitForStatus(manager, "project-fixture", "ready");
    await new Promise((resolve) => portLease.close(resolve));
    check(
      "restart-keeps-url-and-changes-target-port",
      restarted.url === originalUrl && restarted.targetPort !== originalPort,
      { originalUrl, originalPort, restarted },
    );

    await writeFile(mainConfigPath, buildConfig("b"));
    const changed = await manager.list("project-fixture", "project-fixture");
    const stillOld = JSON.parse(
      (await request(proxyPort, "/inspect", { headers: { Host: primaryHost } })).body,
    );
    check(
      "running-service-marks-stale-without-restart",
      changed.services[0].staleConfig && stillOld.variant === "a",
      { changed: changed.services[0], stillOld },
    );

    await assert.rejects(
      manager.acquireDeletionGuard(["project-fixture"]),
      (error) => error?.code === "start_blocked",
    );
    check("active-service-blocks-deletion-guard", true, {});
    await Promise.all(
      contextEntries.map(([projectId]) =>
        manager.stop({
          parentProjectId: "project-fixture",
          projectId,
          serviceName: "web",
        }),
      ),
    );
    const releaseDeletionGuard = await manager.acquireDeletionGuard([
      "project-fixture",
    ]);
    const guardedList = await manager.list("project-fixture", "project-fixture");
    await assert.rejects(
      manager.start({
        parentProjectId: "project-fixture",
        projectId: "project-fixture",
        serviceName: "web",
        configRevision: guardedList.config.revision,
      }),
      (error) => error?.code === "context_deleting",
    );
    releaseDeletionGuard();
    check("deletion-guard-rejects-new-start", true, {});

    await writeFile(
      mainConfigPath,
      `${JSON.stringify({ schemaVersion: 1, services: {}, unknown: true })}\n`,
    );
    const invalid = await manager.list("project-fixture", "project-fixture");
    check(
      "invalid-config-fails-closed",
      invalid.config.status === "invalid" && invalid.services.length === 0,
      invalid,
    );
    await writeFile(mainConfigPath, buildConfig());

    externalProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const externalPid = externalProcess.pid;
    await manager.dispose();
    check(
      "normal-dispose-does-not-kill-unowned-process",
      processIsAlive(externalPid),
      { externalPid },
    );
    const allOwned = (
      await Promise.all(contextEntries.map(([, context]) => readOwnedPids(context.path)))
    ).flat();
    await waitUntil(
      () => allOwned.every(({ pid, childPid }) => !processIsAlive(pid) && !processIsAlive(childPid)),
      5_000,
    );
    check("normal-dispose-reclaims-all-owned-processes", true, allOwned);

    await writeFile(mainConfigPath, buildConfig("crash"));
    await verifyCrashCleanup(root);
    console.log(`Workspace Services verifier passed (${checks.length} checks)`);
    for (const name of checks) console.log(`- ${name}`);
  } finally {
    externalProcess?.kill("SIGKILL");
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
    await rm(`${root}-wt-a`, { recursive: true, force: true });
    await rm(`${root}-wt-b`, { recursive: true, force: true });
  }
}

if (process.argv.includes("--service-fixture")) {
  await runServiceFixture();
} else if (process.argv.includes("--crash-harness")) {
  await runCrashHarness(process.argv.at(-1));
} else {
  await main();
}
