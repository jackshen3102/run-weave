/** Real TCP/HTTP/WebSocket integration checks; owns and closes all of its resources. */
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { AuthService } from "../../../backend/src/auth/service";
import { LocalBrowserService } from "../../../backend/src/browser-local/service";
import { attachLocalBrowserWebSocketServer } from "../../../backend/src/ws/browser-local-server";
import { createHttpUpgradeRouter } from "../../../backend/src/server/http-upgrade-router";
const require = createRequire(
  new URL("../../../backend/package.json", import.meta.url),
);
const { WebSocket } = require("ws") as typeof import("ws");
const runId = randomUUID();
const auth = new AuthService({
  username: "fixture",
  password: runId,
  jwtSecret: randomUUID(),
  accessTokenTtlMs: 600000,
  refreshTokenTtlMs: 600000,
  refreshCookieName: "fixture",
  secureCookies: false,
});
const app = (await auth.login("fixture", runId, {
  clientType: "app",
  connectionId: runId,
}))!;
const web = (await auth.login("fixture", runId))!;
let available = true;
const service = new LocalBrowserService(
  (authId, terminalId) =>
    available && terminalId === runId && !!auth.getActiveAppSession(authId),
);
const peers = new Set<net.Socket>();
let submissions = 0;
const target = http.createServer(async (req, res) => {
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.headers["proxy-authorization"], undefined);
  if (req.method === "POST") {
    submissions++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.end(Buffer.concat(chunks));
  } else {
    res.end(runId);
  }
});
target.on("connection", (socket) => {
  peers.add(socket);
  socket.on("close", () => peers.delete(socket));
});
target.listen(0, "127.0.0.1");
await once(target, "listening");
const targetPort = (target.address() as net.AddressInfo).port;
const server = http.createServer();
const wss = attachLocalBrowserWebSocketServer(
  createHttpUpgradeRouter(server),
  service,
  auth,
  null,
);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `ws://127.0.0.1:${(server.address() as net.AddressInfo).port}/ws/browser-local`;
const clients = new Set<InstanceType<typeof WebSocket>>();
async function connect(
  token = app.accessToken,
  headers: Record<string, string> = {},
) {
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}`, ...headers },
  });
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  await once(ws, "open");
  return ws;
}
function next(ws: InstanceType<typeof WebSocket>): Promise<[Buffer, boolean]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clean();
      reject(new Error("message timeout"));
    }, 12000);
    const message = (data: Buffer, binary: boolean) => {
      clean();
      resolve([data, binary]);
    };
    const close = () => {
      clean();
      reject(new Error("unexpected close"));
    };
    function clean() {
      clearTimeout(timer);
      ws.off("message", message);
      ws.off("close", close);
    }
    ws.once("message", message);
    ws.once("close", close);
  });
}
async function open(ws: InstanceType<typeof WebSocket>, fields = {}) {
  const response = next(ws);
  ws.send(
    JSON.stringify({
      type: "open",
      version: 1,
      terminalSessionId: runId,
      browserSessionId: runId,
      host: "127.0.0.1",
      port: targetPort,
      secure: false,
      ...fields,
    }),
  );
  return JSON.parse((await response)[0].toString());
}
try {
  for (const [token, headers] of [
    ["invalid", {}],
    [web.accessToken, {}],
    [app.accessToken, { Origin: "http://localhost" }],
  ] as const) {
    await assert.rejects(connect(token, headers));
  }
  console.log("PASS app-only bearer and Origin rejection");
  for (const host of [
    "172.0.0.1",
    "192.168.1.1",
    "example.com",
    "127.0.0.1.evil",
    "169.254.169.254",
    "::ffff:192.168.1.1",
  ]) {
    const ws = await connect();
    assert.equal((await open(ws, { host })).code, "invalid_target");
    ws.terminate();
  }
  console.log("PASS target allowlist (no arbitrary network/DNS)");
  if (process.env.LOCAL_BROWSER_TLS_DIR) {
    const directory = process.env.LOCAL_BROWSER_TLS_DIR;
    for (const certificate of ["trusted", "untrusted"]) {
      const secure = https.createServer(
        {
          key: readFileSync(path.join(directory, certificate + ".key")),
          cert: readFileSync(path.join(directory, certificate + ".crt")),
        },
        (_req, res) => res.end("TLS fixture"),
      );
      secure.listen(0, "127.0.0.1");
      await once(secure, "listening");
      try {
        for (const host of ["localhost", "127.0.0.1"]) {
          const stream = await connect();
          const result = await open(stream, {
            host,
            port: (secure.address() as net.AddressInfo).port,
            secure: true,
          });
          if (certificate === "trusted" && host === "localhost") {
            assert.equal(result.type, "ready");
            const chunks: Buffer[] = [];
            stream.on("message", (data: Buffer, binary: boolean) => {
              if (binary) chunks.push(data);
            });
            const done = once(stream, "close");
            stream.send(
              Buffer.from(
                "GET / HTTP/1.1\r\nHost: preview.localhost\r\nConnection: close\r\n\r\n",
              ),
            );
            await done;
            assert(Buffer.concat(chunks).includes(Buffer.from("TLS fixture")));
          } else {
            assert.equal(result.code, "target_unavailable");
            stream.terminate();
          }
        }
      } finally {
        secure.closeAllConnections();
        await new Promise<void>((resolve) => secure.close(() => resolve()));
      }
    }
    console.log(
      "PASS HTTPS original-host validation; wrong host and untrusted CA rejected",
    );
  }

  const held = [];
  for (let i = 0; i < 32; i++) {
    const stream = await connect();
    assert.equal((await open(stream)).type, "ready");
    held.push(stream);
  }
  const excess = new WebSocket(url, {
    headers: { Authorization: `Bearer ${app.accessToken}` },
  });
  const excessResult = next(excess);
  assert.equal(
    JSON.parse((await excessResult)[0].toString()).code,
    "connection_limit",
  );
  const released = once(held[0], "close");
  held[0].close();
  await released;
  const replacement = await connect();
  assert.equal((await open(replacement)).type, "ready");
  held.push(replacement);
  await Promise.all(
    held.slice(1).map(async (stream) => {
      const closed = once(stream, "close");
      stream.close();
      await closed;
    }),
  );
  console.log("PASS 32 connection cap and released capacity");
  for (const fields of [
    { version: 2 },
    { port: 0 },
    { terminalSessionId: "missing" },
  ]) {
    const stream = await connect();
    assert.equal((await open(stream, fields)).type, "error");
    stream.terminate();
  }
  const beforeOpen = await connect();
  const rejected = next(beforeOpen);
  beforeOpen.send(Buffer.from("not an open"));
  assert.equal(
    JSON.parse((await rejected)[0].toString()).code,
    "protocol_error",
  );
  beforeOpen.terminate();
  console.log("PASS version, port, source and pre-open binary rejection");
  const ws = await connect();
  assert.equal((await open(ws)).type, "ready");
  const chunks: Buffer[] = [];
  ws.on("message", (data: Buffer, binary: boolean) => {
    if (binary) chunks.push(data);
  });
  const body = Buffer.alloc(8 * 1024 * 1024, 97);
  ws.send(
    Buffer.from(
      `POST /echo HTTP/1.1\r\nHost: preview.localhost:${targetPort}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
    ),
  );
  for (let offset = 0; offset < body.length; offset += 65536) {
    await new Promise<void>((resolve, reject) =>
      ws.send(body.subarray(offset, offset + 65536), (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
  const finished = once(ws, "close");
  ws.send(JSON.stringify({ type: "eof" }));
  await finished;
  const response = Buffer.concat(chunks);
  assert.deepEqual(response.subarray(response.indexOf("\r\n\r\n") + 4), body);
  assert.equal(submissions, 1);
  console.log(
    "PASS 8 MiB POST byte fidelity, half-close, no replay, no credential leakage",
  );
  const live = await connect();
  assert.equal((await open(live)).type, "ready");
  const invalidation = next(live);
  available = false;
  assert.equal(
    JSON.parse((await invalidation)[0].toString()).code,
    "source_unavailable",
  );
  console.log("PASS source revocation closes existing stream within 5 seconds");
  available = true;
  const disposed = await connect();
  assert.equal((await open(disposed)).type, "ready");
  const closed = once(disposed, "close");
  service.dispose();
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(peers.size, 0);
  console.log("PASS dispose closes outbound TCP and WS");
} finally {
  service.dispose();
  for (const ws of clients) ws.terminate();
  for (const socket of peers) socket.destroy();
  await Promise.all([
    new Promise<void>((r) => wss.close(() => r())),
    new Promise<void>((r) => server.close(() => r())),
    new Promise<void>((r) => target.close(() => r())),
  ]);
}
