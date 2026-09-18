// Real running Backend acceptance. Credentials remain in memory; only owned resources are deleted.
import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
const require = createRequire(
  new URL("../../../backend/package.json", import.meta.url),
);
const { WebSocket } = require("ws");
const [base, expectedSession, authStore, caseId] = process.argv.slice(2);
assert(
  base && expectedSession && authStore && caseId,
  "baseURL devSessionId authStore caseId required",
);
assert.equal(
  (await (await fetch(base + "/health")).json()).devSessionId,
  expectedSession,
);
const credentials = JSON.parse(readFileSync(authStore)).auth;
const clients = new Set(),
  peers = new Set();
const sessions = [];
let project,
  terminal,
  totalConnections = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(path, body, token, method) {
  const response = await fetch(base + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Client": "app",
      "X-Connection-ID": randomUUID(),
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert(response.ok, `API ${path} returned ${response.status}`);
  const value = await response.text();
  return value ? JSON.parse(value) : null;
}
async function login() {
  const session = await api("/api/auth/login", {
    username: credentials.username,
    password: credentials.password,
  });
  sessions.push(session);
  return session;
}
const auth = await login();
const target = net.createServer({ allowHalfOpen: true }, (socket) => {
  peers.add(socket);
  totalConnections++;
  socket.on("error", () => {});
  socket.on("close", () => peers.delete(socket));
  // A half-open fixture must consume FIN and finish its own writing direction.
  // The dedicated EOF case supplies its response before finishing instead.
  if (caseId !== "IOSLOCALSAFE-017") {
    socket.on("end", () => socket.end());
    socket.resume();
  }
});
target.listen(0, "127.0.0.1");
await once(target, "listening");
const port = target.address().port;
const url = base.replace(/^http/, "ws") + "/ws/browser-local";
const queues = new WeakMap();
function create(token = auth.accessToken) {
  const ws = new WebSocket(url, {
    headers: { Authorization: "Bearer " + token },
  });
  clients.add(ws);
  const queue = { values: [], waiter: null, closed: false };
  queues.set(ws, queue);
  ws.on("message", (data, binary) => {
    const value = binary ? data : JSON.parse(data.toString());
    if (queue.waiter) {
      const waiter = queue.waiter;
      queue.waiter = null;
      waiter(value);
    } else queue.values.push(value);
  });
  ws.on("close", () => {
    clients.delete(ws);
    queue.closed = true;
    if (queue.waiter) {
      queue.waiter(null);
      queue.waiter = null;
    }
  });
  return ws;
}
function next(ws) {
  const q = queues.get(ws);
  if (q.values.length) return Promise.resolve(q.values.shift());
  if (q.closed) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      q.waiter = null;
      reject(Error("frame timeout"));
    }, 12000);
    q.waiter = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
  });
}
async function connect(token) {
  const ws = create(token);
  await once(ws, "open");
  return ws;
}
function request(fields = {}) {
  return {
    type: "open",
    version: 1,
    terminalSessionId: terminal,
    browserSessionId: randomUUID(),
    host: "127.0.0.1",
    port,
    secure: false,
    ...fields,
  };
}
async function open(ws, fields) {
  ws.send(JSON.stringify(request(fields)));
  return next(ws);
}
async function close(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  const done = once(ws, "close");
  ws.close();
  await done;
}
async function baseline() {
  for (let i = 0; i < 50 && peers.size; i++) await pause(20);
  assert.equal(peers.size, 0);
}
try {
  project = (
    await api(
      "/api/terminal/project",
      { name: `Local ${caseId}`, path: "/private/tmp" },
      auth.accessToken,
    )
  ).projectId;
  terminal = (
    await api(
      "/api/terminal/session",
      { projectId: project, runtimePreference: "pty" },
      auth.accessToken,
    )
  ).terminalSessionId;
  if (caseId === "IOSLOCALSAFE-002") {
    for (const fields of [
      ...[
        "example.com",
        "192.168.1.1",
        "172.0.0.1",
        "localhost.evil.example",
        "localhost@evil.example",
        "127.0.0.1.nip.io",
      ].map((host) => ({ host })),
      ...["80", 0, -1, 65536].map((port) => ({ port })),
    ]) {
      const ws = await connect();
      assert.equal((await open(ws, fields)).code, "invalid_target");
      await close(ws);
    }
    const missing = await connect();
    assert.equal(
      (await open(missing, { terminalSessionId: "absent" })).code,
      "source_unavailable",
    );
    await close(missing);
    assert.equal(totalConnections, 0);
    const valid = await connect();
    assert.equal((await open(valid)).type, "ready");
    assert.equal(totalConnections, 1);
    await close(valid);
    await baseline();
  } else if (caseId === "IOSLOCALSAFE-012") {
    const other = await login();
    const healthy = await connect(other.accessToken);
    assert.equal((await open(healthy)).type, "ready");
    const held = [];
    for (let i = 0; i < 32; i++) {
      const ws = await connect();
      assert.equal((await open(ws)).type, "ready");
      held.push(ws);
    }
    const excess = create();
    assert.equal((await next(excess)).code, "connection_limit");
    await close(excess);
    assert.equal(peers.size, 33);
    await close(held.shift());
    const replacement = await connect();
    assert.equal((await open(replacement)).type, "ready");
    held.push(replacement);
    for (const ws of held) await close(ws);
    await pause(100);
    assert.equal(peers.size, 1);
    assert.equal(healthy.readyState, WebSocket.OPEN);
    const marker = randomUUID();
    for (const socket of peers) socket.write(marker);
    assert.equal((await next(healthy)).toString(), marker);
    await close(healthy);
    await baseline();
  } else if (caseId === "IOSLOCALSAFE-013") {
    const idle = await connect();
    const start = performance.now();
    assert.equal((await next(idle)).code, "protocol_error");
    assert(performance.now() - start >= 4900);
    await close(idle);
    assert.equal(totalConnections, 0);
    for (const [data, expected] of [
      ["x".repeat(2049), "protocol_error"],
      [JSON.stringify(request({ version: 2 })), "unsupported_version"],
      [Buffer.from("binary"), "protocol_error"],
    ]) {
      const ws = await connect();
      ws.send(data);
      assert.equal((await next(ws)).code, expected);
      await close(ws);
    }
    assert.equal(totalConnections, 0);
    const repeat = await connect();
    assert.equal((await open(repeat)).type, "ready");
    assert.equal((await open(repeat)).code, "protocol_error");
    await close(repeat);
    await baseline();
    assert.equal(totalConnections, 1);
    const oversize = await connect();
    assert.equal((await open(oversize)).type, "ready");
    const done = once(oversize, "close");
    oversize.send(Buffer.alloc(65537));
    assert.equal((await done)[0], 1009);
    await baseline();
    assert.equal(totalConnections, 2);
  } else if (caseId === "IOSLOCALSAFE-017") {
    const input = Buffer.alloc(2 * 1024 * 1024 + 97, 37),
      output = Buffer.alloc(3 * 1024 * 1024 + 123, 83);
    let received,
      eof = false;
    target.on("connection", (socket) => {
      const chunks = [];
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => {
        received = Buffer.concat(chunks);
        eof = true;
        socket.end(output);
      });
    });
    const ws = await connect();
    assert.equal((await open(ws)).type, "ready");
    for (let i = 0; i < input.length; i += 65536)
      await new Promise((resolve, reject) =>
        ws.send(input.subarray(i, i + 65536), (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    ws.send(JSON.stringify({ type: "eof" }));
    const chunks = [];
    let remoteEOF = false;
    for (;;) {
      const message = await next(ws);
      if (message === null) break;
      if (Buffer.isBuffer(message)) chunks.push(message);
      else {
        assert.equal(message.type, "eof");
        remoteEOF = true;
      }
    }
    assert(eof && remoteEOF);
    assert.deepEqual(received, input);
    const actual = Buffer.concat(chunks);
    assert.deepEqual(actual, output);
    await baseline();
    console.log(
      JSON.stringify({
        inputBytes: input.length,
        outputBytes: actual.length,
        sha256: createHash("sha256").update(actual).digest("hex"),
      }),
    );
  } else throw Error("Unsupported case");
  console.log(
    JSON.stringify({
      caseId,
      status: "passed",
      devSessionId: expectedSession,
      totalConnections,
      activeTargetSockets: peers.size,
    }),
  );
} finally {
  for (const ws of clients) ws.terminate();
  for (const socket of peers) socket.destroy();
  await new Promise((resolve) => target.close(resolve));
  if (terminal)
    await api(
      "/api/terminal/session/" + terminal,
      undefined,
      auth.accessToken,
      "DELETE",
    );
  if (project)
    await api(
      "/api/terminal/project/" + project,
      undefined,
      auth.accessToken,
      "DELETE",
    );
  for (const session of sessions)
    await api("/api/auth/logout", {}, session.accessToken);
}
