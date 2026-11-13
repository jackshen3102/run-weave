import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
// Real CLI subprocesses and HTTP/WebSocket peers. This is not browser UI acceptance.
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const { configurationLibrary: config } = await import(
  repo + "/scripts/lib/configuration.mjs"
);
const require = createRequire(repo + "/packages/runweave-cli/package.json");
const { WebSocketServer } = require("ws");
const root = mkdtempSync(path.join(os.tmpdir(), "rw-browser-control-"));
const home = path.join(root, "home");
mkdirSync(home, { mode: 0o700 });
const context = {
  kind: "stable",
  instanceId: "stable",
  configRoot: path.join(home, ".runweave"),
};
mkdirSync(context.configRoot, { mode: 0o700 });
context.configRoot = realpathSync(context.configRoot);
const preloader = path.join(root, "home.cjs");
writeFileSync(
  preloader,
  `const os=require('node:os');const info=os.userInfo();os.userInfo=()=>({...info,homedir:${JSON.stringify(home)}});os.homedir=()=>${JSON.stringify(home)};`,
);
let mode = "normal",
  healthRequests = 0,
  hookRequests = 0;
const secret = "fixture-private-ticket-42";
let proxyMode = "whistle";
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") {
    healthRequests++;
    if (mode === "transient" && healthRequests === 1) {
      res.writeHead(503);
      res.end("{}");
      return;
    }
    if (mode === "hang") {
      res.writeHead(200);
      res.write("{");
      return;
    }
    res.end(
      JSON.stringify({
        environment:
          mode === "mismatch" ? { ...context, instanceId: "another" } : context,
      }),
    );
    return;
  }
  if (req.url?.endsWith("/runtime-identity")) {
    hookRequests++;
    res.end(
      JSON.stringify({
        terminalSessionId: "fixture-terminal",
        projectId: "fixture-project",
      }),
    );
    return;
  }
  if (req.url?.endsWith("/browser/capability")) {
    res.writeHead(409);
    res.end(
      JSON.stringify({
        code: "BROWSER_BINDING_REQUIRED",
        message: "fixture has no desktop " + secret,
      }),
    );
    return;
  }
  if (req.url === "/runweave/browser-profile/resolve") {
    if (mode === "binding-denied") {
      res.writeHead(403);
      res.end(
        JSON.stringify({
          error: { code: "BROWSER_SCOPE_DENIED", message: "private " + secret },
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        profileId: "profile-1",
        source: "global-default",
        projectId: "fixture-project",
        browserGroupId: "fixture-group",
        route: { kind: "unassigned" },
        cdpEndpoint: `ws://127.0.0.1:${server.address().port}/${secret}`,
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end("{}");
});
const wss = new WebSocketServer({ server });
wss.on("connection", (socket) =>
  socket.on("message", (data) => {
    const m = JSON.parse(data);
    assert.equal(m.method, "Runweave.getProxyState");
    socket.send(
      JSON.stringify({
        id: m.id,
        result: {
          profileId: "profile-1",
          proxyMode,
          whistle: { status: mode === "whistle-failed" ? "failed" : "ready" },
          effectiveProxy: "PROXY 127.0.0.1:8081",
          applyError:
            mode === "apply-error"
              ? { code: "PROXY_APPLY_FAILED", message: secret }
              : null,
        },
      }),
    );
  }),
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const value = config.prepareInitialConfiguration(context, {
  username: "isolated",
  password: "isolated-long-password",
});
config.setConfigurationValue(value, "backend.server.port", port);
writeFileSync(
  path.join(context.configRoot, "settings.yaml"),
  JSON.stringify(value),
  { mode: 0o600 },
);
const env = {
  ...process.env,
  NODE_OPTIONS: `--require=${JSON.stringify(preloader)}`,
};
for (const k of Object.keys(env))
  if (k.startsWith("RUNWEAVE_") || k.startsWith("PLAYWRIGHT_")) delete env[k];
const cli = path.resolve(
  process.argv.find((arg) => arg.startsWith("--cli-entry="))?.slice(12) ??
    path.join(repo, "packages/runweave-cli/dist/index.js"),
);
async function invoke(ambient, timeout = "0", args = []) {
  const e = {
    ...env,
    RUNWEAVE_TERMINAL_SESSION_ID: "fixture-terminal",
    RUNWEAVE_PROJECT_ID: "fixture-project",
    RUNWEAVE_HOOK_TOKEN: "fixture-hook",
  };
  if (ambient) {
    e.PLAYWRIGHT_MCP_CDP_ENDPOINT = `ws://127.0.0.1:${port}/ambient`;
    e.RUNWEAVE_BASE_URL = `http://127.0.0.1:${port}`;
  }
  const start = Date.now();
  const r = await new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [
        cli,
        "--instance",
        "stable",
        "--config-dir",
        context.configRoot,
        "browser",
        "doctor",
        "--wait-timeout-ms",
        timeout,
        "--json",
        ...args,
      ],
      { env: e, stdio: ["ignore", "pipe", "pipe"], timeout: 12000 },
    );
    let out = "",
      err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      resolve({ code, out, err, elapsedMs: Date.now() - start }),
    );
  });
  assert(
    !r.out.includes(secret) && !r.err.includes(secret),
    "Diagnostic leaked peer credentials",
  );
  return { ...r, report: r.out ? JSON.parse(r.out) : null };
}
const checks = [];
try {
  let r = await invoke(false);
  assert.equal(r.code, 3);
  assert.equal(r.report.checks[0].status, "passed");
  assert.equal(r.report.checks[1].code, "BROWSER_BINDING_REQUIRED");
  checks.push("legacy address discovery authenticates its original terminal");
  mode = "transient";
  healthRequests = 0;
  r = await invoke(false, "2500");
  assert.equal(healthRequests, 2);
  assert.equal(r.report.checks[0].status, "passed");
  assert(r.elapsedMs < 3500);
  checks.push(
    "transient Backend discovery recovers within one resolver invocation",
  );
  mode = "mismatch";
  hookRequests = 0;
  r = await invoke(false);
  assert.equal(r.report.checks[0].code, "CONFIG_TARGET_MISMATCH");
  assert.equal(hookRequests, 0);
  checks.push("wrong Backend receives no terminal Hook");
  mode = "hang";
  r = await invoke(false, "300");
  assert.equal(r.code, 3);
  assert(r.elapsedMs < 1800);
  checks.push("hanging discovery body obeys shared deadline");
  mode = "normal";
  r = await invoke(true);
  assert.equal(r.code, 0);
  assert(r.report.healthy);
  assert.equal(r.report.pageRequestsVerified, false);
  assert(r.report.checks.every((c) => c.status === "passed"));
  checks.push(
    "real CLI HTTP/WebSocket control diagnosis succeeds without page navigation",
  );
  mode = "binding-denied";
  r = await invoke(true);
  assert.equal(r.report.checks[1].code, "BROWSER_SCOPE_DENIED");
  assert.equal(r.report.checks[2].status, "skipped");
  checks.push("binding refusal stops later stages and redacts peer error");
  mode = "apply-error";
  r = await invoke(true);
  assert.equal(r.code, 3);
  assert.equal(r.report.checks[3].code, "PROXY_APPLY_FAILED");
  checks.push("proxy apply failure is isolated to proxy stage");
  mode = "whistle-failed";
  r = await invoke(true);
  assert.equal(r.report.checks[3].code, "WHISTLE_UNAVAILABLE");
  checks.push("failed Whistle is not reported healthy");
  mode = "normal";
  r = await invoke(true, "0", ["--unknown"]);
  assert.equal(r.code, 2);
  assert.equal(r.out, "");
  checks.push("invalid arguments retain exit code 2");
  console.log(
    JSON.stringify(
      {
        ok: true,
        coverage: "CLI + real HTTP/WebSocket integration; no browser UI",
        checks,
        fixture: root,
      },
      null,
      2,
    ),
  );
} finally {
  for (const s of wss.clients) s.terminate();
  await new Promise((r) => wss.close(r));
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
}
