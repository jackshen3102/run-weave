import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildCompletionEvent,
  buildHookEvent,
} from "./app-server-threadref-fixture.mjs";

export function createStateSyncHarness({
  WebSocket,
  fakeCodexBinPath,
  ids,
  repoRoot,
  source,
}) {
  function hookEvent(hookEventName, overrides = {}) {
    return buildHookEvent(ids, hookEventName, { source, ...overrides });
  }

  function completionEvent(reason, rawHookEvent) {
    return buildCompletionEvent(ids, reason, rawHookEvent, { source });
  }

  function startAppServer({ stateDir, syncDir }) {
    const child = spawn(process.execPath, ["app-server/dist/index.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        RUNWEAVE_APP_SERVER_STATE_DIR: stateDir,
        RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR: syncDir,
        RUNWEAVE_APP_SERVER_PORT: "0",
        RUNWEAVE_APP_SERVER_CODEX_STATUS_START_DELAY_MS: "100",
        RUNWEAVE_APP_SERVER_CODEX_STATUS_INTERVAL_MS: "100",
        CODEX_BIN: fakeCodexBinPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return waitForReady(child, stateDir);
  }

  async function waitForReady(child, stateDir) {
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
        const context = await readContext(stateDir);
        const response = await fetch(`${context.baseUrl}/healthz`);
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

  async function readContext(stateDir) {
    const lock = JSON.parse(
      await readFile(path.join(stateDir, "app-server.lock.json"), "utf8"),
    );
    const token = (
      await readFile(path.join(stateDir, "app-server-token"), "utf8")
    ).trim();
    return {
      stateDir,
      token,
      baseUrl: `http://${lock.host}:${lock.port}`,
    };
  }

  async function stopAppServer(child) {
    if (child.exitCode !== null) {
      return;
    }
    child.kill("SIGTERM");
    await new Promise((resolve) => child.on("close", resolve));
  }

  async function postEvent(context, body) {
    const response = await fetch(`${context.baseUrl}/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${context.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  async function getThread(context, threadId) {
    return getJson(context, `/threads/${encodeURIComponent(threadId)}`);
  }

  async function getJson(context, pathName) {
    const response = await fetch(`${context.baseUrl}${pathName}`, {
      headers: { Authorization: `Bearer ${context.token}` },
    });
    assert.equal(response.ok, true, `${pathName} returned ${response.status}`);
    return response.json();
  }

  async function assertStatus(context, pathName, expectedStatus, token) {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const response = await fetch(`${context.baseUrl}${pathName}`, { headers });
    assert.equal(response.status, expectedStatus, pathName);
  }

  async function connectStream(url, token) {
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const messages = [];
    socket.on("message", (raw) => {
      messages.push(JSON.parse(String(raw)));
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await waitFor(() => messages.some((message) => message.type === "events"));
    return {
      close: () => socket.close(),
      messages,
    };
  }

  function collectLiveEvents(stream, count) {
    return waitFor(() => {
      const events = stream.messages
        .filter((message) => message.type === "event")
        .map((message) => message.event);
      return events.length >= count ? events.slice(0, count) : null;
    });
  }

  function waitFor(predicate) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const tick = async () => {
        const value = await predicate();
        if (value) {
          resolve(value);
          return;
        }
        if (Date.now() - startedAt > 10_000) {
          reject(new Error("Timed out waiting for condition"));
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  async function readJson(filePath) {
    return JSON.parse(await readFile(filePath, "utf8"));
  }

  async function readJsonl(filePath) {
    const content = await readFile(filePath, "utf8");
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async function writeFakeCodexBin(filePath) {
    await writeFile(
      filePath,
      `#!/usr/bin/env node
  import readline from "node:readline";

  const rl = readline.createInterface({ input: process.stdin });

  rl.on("line", (line) => {
    const message = JSON.parse(line);
    if (!message.id) {
      return;
    }
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
      return;
    }
    if (message.method === "thread/read" || message.method === "thread/resume") {
      const threadId = message.params?.threadId;
      const type =
        threadId === "thread-compensation"
          ? "idle"
          : threadId === "thread-active-compensation"
            ? "active"
            : null;
      process.stdout.write(
        JSON.stringify({
          id: message.id,
          result: type ? { thread: { status: { type } } } : {},
        }) + "\\n",
      );
    }
  });
  `,
      "utf8",
    );
    await chmod(filePath, 0o755);
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

  function contextTokenPattern() {
    return "app-server-token";
  }

  return {
    assertStatus,
    collectLiveEvents,
    completionEvent,
    connectStream,
    contextTokenPattern,
    getJson,
    getThread,
    hookEvent,
    postEvent,
    readContext,
    readJson,
    readJsonl,
    run,
    startAppServer,
    stopAppServer,
    waitFor,
    writeFakeCodexBin,
  };
}
