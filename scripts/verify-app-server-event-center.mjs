import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const requireFromAppServer = createRequire(
  new URL("../app-server/package.json", import.meta.url),
);
const { WebSocket } = requireFromAppServer("ws");
const stateDir = await mkdtemp(path.join(os.tmpdir(), "runweave-app-server-"));
const cloudSyncDir = path.join(stateDir, "app-server-cloud-sync-sim");

let appServer = null;
try {
  await run("pnpm", ["--filter", "@runweave/app-server", "build"]);
  await verifyConcurrentEventAppend();
  await verifyEventLogRetention();
  appServer = await startAppServer();
  const lock = await readLock();
  const token = (
    await readFile(path.join(stateDir, "app-server-token"), "utf8")
  ).trim();
  const baseUrl = `http://${lock.host}:${lock.port}`;

  const duplicate = await runSecondAppServer();
  assert.equal(duplicate.code, 0);
  assert.match(duplicate.stdout, /already running/);

  const first = await postEvent(baseUrl, token, {
    kind: "diagnostic.created",
    source: { app: "cli", instanceId: "verify-script", pid: process.pid },
    dedupeKey: "verify:diagnostic:1",
    payload: { message: "hello" },
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.event.id, "1");

  const deduped = await postEvent(baseUrl, token, {
    kind: "diagnostic.created",
    source: { app: "cli", instanceId: "verify-script", pid: process.pid },
    dedupeKey: "verify:diagnostic:1",
    payload: { message: "hello again" },
  });
  assert.equal(deduped.status, 200);
  assert.equal(deduped.body.event.id, first.body.event.id);

  const queried = await getJson(
    `${baseUrl}/events?after=0&kind=diagnostic.created`,
    token,
  );
  assert.equal(queried.events.length, 1);
  assert.equal(queried.events[0].payload.message, "hello");
  assert.equal(queried.latestEventId, "1");

  const stream = await connectStream(
    `${baseUrl.replace(/^http/, "ws")}/events/stream?after=0&kind=diagnostic.created`,
    token,
  );
  const secondStream = await connectStream(
    `${baseUrl.replace(/^http/, "ws")}/events/stream?after=0&kind=diagnostic.created`,
    token,
  );
  assert.equal(stream.messages[0].type, "connected");
  assert.equal(stream.messages[1].type, "events");
  assert.equal(stream.messages[1].events.length, 1);
  assert.equal(secondStream.messages[0].type, "connected");
  assert.equal(secondStream.messages[1].type, "events");
  assert.equal(secondStream.messages[1].events.length, 1);

  const live = waitForMessage(stream, (message) => message.type === "event");
  const secondLive = waitForMessage(
    secondStream,
    (message) => message.type === "event",
  );
  const second = await postEvent(baseUrl, token, {
    kind: "diagnostic.created",
    source: { app: "cli", instanceId: "verify-script-live", pid: process.pid },
    payload: { message: "live" },
  });
  assert.equal(second.status, 201);
  const liveMessage = await live;
  const secondLiveMessage = await secondLive;
  assert.equal(liveMessage.event.id, "2");
  assert.equal(liveMessage.event.payload.message, "live");
  assert.equal(secondLiveMessage.event.id, "2");
  assert.equal(secondLiveMessage.event.payload.message, "live");
  stream.close();
  secondStream.close();

  await stopAppServer(appServer);
  appServer = await startAppServer();
  const restartedLock = await readLock();
  const restartedBaseUrl = `http://${restartedLock.host}:${restartedLock.port}`;
  const afterRestart = await getJson(
    `${restartedBaseUrl}/events?after=0`,
    token,
  );
  assert.equal(afterRestart.events.length, 2);
  assert.equal(afterRestart.latestEventId, "2");
  await verifyAuthOriginQueryAndPayloadValidation(restartedBaseUrl, token);
  await verifyWebSocketCatchupPagination(restartedBaseUrl, token);
  await verifyConcurrentHttpAppend(restartedBaseUrl, token);

  console.log("app-server event center verification passed");
} finally {
  if (appServer) {
    await stopAppServer(appServer);
  }
  await rm(stateDir, { recursive: true, force: true });
}

function startAppServer() {
  const child = spawn(process.execPath, ["app-server/dist/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RUNWEAVE_APP_SERVER_STATE_DIR: stateDir,
      RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR: cloudSyncDir,
      RUNWEAVE_APP_SERVER_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return waitForReady(child);
}

async function waitForReady(child) {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`app-server exited early: ${stderr}`);
    }
    try {
      const lock = await readLock();
      const response = await fetch(`http://${lock.host}:${lock.port}/healthz`);
      if (response.ok) {
        return child;
      }
    } catch {
      // Keep polling until the server writes the lock and answers health.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`app-server did not become ready: ${stderr}`);
}

function runSecondAppServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["app-server/dist/index.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        RUNWEAVE_APP_SERVER_STATE_DIR: stateDir,
        RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR: cloudSyncDir,
        RUNWEAVE_APP_SERVER_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function run(command, args) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function stopAppServer(child) {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => child.on("close", resolve));
}

async function readLock() {
  return JSON.parse(
    await readFile(path.join(stateDir, "app-server.lock.json"), "utf8"),
  );
}

async function verifyConcurrentEventAppend() {
  const concurrentStateDir = await mkdtemp(
    path.join(os.tmpdir(), "runweave-app-server-concurrent-append-"),
  );
  try {
    const { AppServerEventStore } =
      await import("../app-server/dist/event-store.js");
    const eventLogPath = path.join(concurrentStateDir, "events.jsonl");
    const store = new AppServerEventStore(eventLogPath);
    await store.initialize();
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        store.append({
          kind: "diagnostic.concurrent",
          source: {
            app: "cli",
            instanceId: "concurrent-append-verify",
            pid: process.pid,
          },
          payload: { index },
        }),
      ),
    );
    const ids = results.map((result) => result.event.id);
    assert.equal(new Set(ids).size, 40);
    assert.deepEqual(
      ids,
      Array.from({ length: 40 }, (_, index) => String(index + 1)),
    );
  } finally {
    await rm(concurrentStateDir, { recursive: true, force: true });
  }
}

async function verifyWebSocketCatchupPagination(baseUrl, token) {
  for (let index = 0; index < 120; index += 1) {
    const response = await postEvent(baseUrl, token, {
      kind: "diagnostic.catchup",
      source: {
        app: "cli",
        instanceId: "catchup-pagination-verify",
        pid: process.pid,
      },
      payload: { index },
    });
    assert.equal(response.status, 201);
  }

  const stream = await connectCatchupStream(
    `${baseUrl.replace(/^http/, "ws")}/events/stream?after=0&kind=diagnostic.catchup`,
    token,
    120,
  );
  const catchupMessages = stream.messages.filter(
    (message) => message.type === "events",
  );
  assert.deepEqual(
    catchupMessages.map((message) => message.events.length),
    [100, 20],
  );
  const events = catchupMessages.flatMap((message) => message.events);
  assert.equal(events.length, 120);
  assert.equal(new Set(events.map((event) => event.id)).size, 120);
  stream.close();
}

async function verifyConcurrentHttpAppend(baseUrl, token) {
  const responses = await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      postEvent(baseUrl, token, {
        kind: "diagnostic.concurrent-http",
        source: {
          app: "cli",
          instanceId: "concurrent-http-verify",
          pid: process.pid,
        },
        payload: { index },
      }),
    ),
  );
  assert.equal(
    responses.every((response) => response.status === 201),
    true,
  );
  const ids = responses.map((response) => response.body.event.id);
  assert.equal(new Set(ids).size, 40);

  const mirrorEvents = (
    await readFile(
      path.join(cloudSyncDir, "events", "app-server-events.jsonl"),
      "utf8",
    )
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.kind === "diagnostic.concurrent-http");
  assert.equal(mirrorEvents.length, 40);
  assert.equal(new Set(mirrorEvents.map((event) => event.id)).size, 40);
}

async function verifyEventLogRetention() {
  const retentionStateDir = await mkdtemp(
    path.join(os.tmpdir(), "runweave-app-server-retention-"),
  );
  try {
    const { AppServerEventStore } =
      await import("../app-server/dist/event-store.js");
    const eventLogPath = path.join(
      retentionStateDir,
      "app-server-events.jsonl",
    );
    const oldEvent = createStoredEvent({
      id: "20",
      createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      dedupeKey: "retention:expired",
      message: "expired",
    });
    const recentEvent = createStoredEvent({
      id: "21",
      createdAt: new Date().toISOString(),
      dedupeKey: "retention:recent",
      message: "recent",
    });
    await writeFile(
      eventLogPath,
      `${JSON.stringify(oldEvent)}\n${JSON.stringify(recentEvent)}\n`,
    );

    const store = new AppServerEventStore(eventLogPath);
    await store.initialize();
    assert.deepEqual(
      store
        .listAfter({ after: null, kinds: [], limit: 10 })
        .map((event) => event.id),
      ["21"],
    );
    assert.equal(store.getLatestId(), "21");

    const recreated = await store.append({
      kind: "diagnostic.created",
      source: { app: "cli", instanceId: "retention-verify", pid: process.pid },
      dedupeKey: "retention:expired",
      payload: { message: "recreated" },
    });
    assert.equal(recreated.created, true);
    assert.equal(recreated.event.id, "22");

    const lines = (await readFile(eventLogPath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map((event) => event.id),
      ["21", "22"],
    );
  } finally {
    await rm(retentionStateDir, { recursive: true, force: true });
  }
}

function createStoredEvent({ id, createdAt, dedupeKey, message }) {
  return {
    id,
    version: 1,
    kind: "diagnostic.created",
    source: { app: "cli", instanceId: "retention-verify", pid: process.pid },
    dedupeKey,
    correlationId: null,
    payload: { message },
    createdAt,
  };
}

async function postEvent(baseUrl, token, body) {
  const response = await fetch(`${baseUrl}/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function verifyAuthOriginQueryAndPayloadValidation(baseUrl, token) {
  const before = await readEventLogLineCount();

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.service, "runweave-app-server");
  assert.equal(healthBody.protocolVersion, 1);

  const ready = await fetch(`${baseUrl}/readyz`);
  assert.equal(ready.status, 200);

  await assertHttpStatus(`${baseUrl}/events`, {
    expectedStatus: 401,
    headers: { "Content-Type": "application/json" },
    method: "POST",
    body: JSON.stringify(validAgentCompletionEvent()),
  });
  await assertHttpStatus(`${baseUrl}/events`, {
    expectedStatus: 401,
    headers: {
      Authorization: "Bearer wrong-token",
      "Content-Type": "application/json",
    },
    method: "POST",
    body: JSON.stringify(validAgentCompletionEvent()),
  });
  await assertHttpStatus(`${baseUrl}/events`, {
    expectedStatus: 403,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Origin: "https://example.com",
    },
    method: "POST",
    body: JSON.stringify(validAgentCompletionEvent()),
  });
  await assertHttpStatus(`${baseUrl}/events`, {
    expectedStatus: 401,
  });
  await assertHttpStatus(`${baseUrl}/events/latest`, {
    expectedStatus: 401,
  });
  await assertHttpStatus(`${baseUrl}/events?after=abc`, {
    expectedStatus: 400,
    token,
  });
  await assertHttpStatus(`${baseUrl}/events?limit=0`, {
    expectedStatus: 400,
    token,
  });

  await assertPostRejected(baseUrl, token, {
    ...validAgentHookEvent(),
    scope: {},
  });
  await assertPostRejected(baseUrl, token, {
    ...validAgentHookEvent(),
    payload: "not-object",
  });
  await assertPostRejected(baseUrl, token, {
    ...validAgentCompletionEvent(),
    payload: {
      completionReason: "hook_stop",
      source: "invalid-source",
    },
  });
  await assertPostRejected(baseUrl, token, {
    ...validAgentCompletionEvent(),
    payload: {
      completionReason: "unsupported",
      source: "codex",
    },
  });

  await assertUnauthorizedWebSocket(
    `${baseUrl.replace(/^http/, "ws")}/events/stream`,
  );
  await assertUnauthorizedWebSocket(
    `${baseUrl.replace(/^http/, "ws")}/events/stream`,
    "wrong-token",
  );
  await assertPolicyCloseWebSocket(
    `${baseUrl.replace(/^http/, "ws")}/events/stream?after=abc`,
    token,
  );

  assert.equal(await readEventLogLineCount(), before);

  const valid = await postEvent(baseUrl, token, validAgentCompletionEvent());
  assert.equal(valid.status, 201);
  const queried = await getJson(
    `${baseUrl}/events?after=0&kind=agent.completion`,
    token,
  );
  assert.equal(
    queried.events.some((event) => event.id === valid.body.event.id),
    true,
  );
}

async function assertHttpStatus(url, options) {
  const headers = { ...(options.headers ?? {}) };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body,
  });
  assert.equal(response.status, options.expectedStatus);
}

async function assertPostRejected(baseUrl, token, body) {
  const response = await postEvent(baseUrl, token, body);
  assert.equal(response.status, 400);
}

function validAgentHookEvent() {
  return {
    kind: "agent.hook",
    source: { app: "hook", instanceId: "verify-hook", pid: process.pid },
    scope: { terminalSessionId: "terminal-verify" },
    payload: { source: "codex" },
  };
}

function validAgentCompletionEvent() {
  return {
    kind: "agent.completion",
    source: { app: "hook", instanceId: "verify-completion", pid: process.pid },
    scope: { terminalSessionId: "terminal-verify" },
    payload: {
      completionReason: "hook_stop",
      source: "codex",
    },
  };
}

function assertUnauthorizedWebSocket(url, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    });
    socket.on("open", () => {
      socket.close();
      reject(new Error("WebSocket unexpectedly opened"));
    });
    socket.on("unexpected-response", (_request, response) => {
      try {
        assert.equal(response.statusCode, 401);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}

function assertPolicyCloseWebSocket(url, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "error") {
        assert.match(message.message, /after must be a numeric event id/);
      }
    });
    socket.on("close", (code) => {
      try {
        assert.equal(code, 1008);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}

async function readEventLogLineCount() {
  const eventLogPath = path.join(stateDir, "app-server-events.jsonl");
  try {
    const eventLogStat = await stat(eventLogPath);
    if (eventLogStat.size === 0) {
      return 0;
    }
    const content = await readFile(eventLogPath, "utf8");
    return content.split(/\r?\n/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function getJson(url, token) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.ok, true);
  return response.json();
}

function connectStream(url, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const messages = [];
    socket.on("message", (raw) => {
      messages.push(JSON.parse(String(raw)));
      if (messages.length >= 2) {
        resolve({
          messages,
          close: () => socket.close(),
          socket,
        });
      }
    });
    socket.on("error", reject);
  });
}

function connectCatchupStream(url, token, expectedEventCount) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const messages = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for paged catchup events"));
    }, 10_000);
    socket.on("message", (raw) => {
      messages.push(JSON.parse(String(raw)));
      const eventCount = messages
        .filter((message) => message.type === "events")
        .reduce((total, message) => total + message.events.length, 0);
      if (eventCount >= expectedEventCount) {
        clearTimeout(timer);
        resolve({
          messages,
          close: () => socket.close(),
        });
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForMessage(stream, predicate) {
  const existing = stream.messages.find(predicate);
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve) => {
    stream.socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      stream.messages.push(message);
      if (predicate(message)) {
        resolve(message);
      }
    });
  });
}
