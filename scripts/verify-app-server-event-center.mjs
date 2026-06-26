import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

let appServer = null;
try {
  appServer = await startAppServer();
  const lock = await readLock();
  const token = (await readFile(path.join(stateDir, "app-server-token"), "utf8"))
    .trim();
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
  const afterRestart = await getJson(`${restartedBaseUrl}/events?after=0`, token);
  assert.equal(afterRestart.events.length, 2);
  assert.equal(afterRestart.latestEventId, "2");

  console.log("app-server event center verification passed");
} finally {
  if (appServer) {
    await stopAppServer(appServer);
  }
  await rm(stateDir, { recursive: true, force: true });
}

function startAppServer() {
  const child = spawn("pnpm", ["--filter", "@runweave/app-server", "start"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RUNWEAVE_APP_SERVER_STATE_DIR: stateDir,
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
    const child = spawn("pnpm", ["--filter", "@runweave/app-server", "start"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        RUNWEAVE_APP_SERVER_STATE_DIR: stateDir,
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
