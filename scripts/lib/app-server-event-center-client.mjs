import assert from "node:assert/strict";
import { createRequire } from "node:module";

const requireFromAppServer = createRequire(
  new URL("../../app-server/package.json", import.meta.url),
);
const { WebSocket } = requireFromAppServer("ws");

export async function postEvent(baseUrl, token, body) {
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

export async function assertHttpStatus(url, options) {
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

export async function assertPostRejected(baseUrl, token, body) {
  const response = await postEvent(baseUrl, token, body);
  assert.equal(response.status, 400);
}

export function validAgentHookEvent() {
  return {
    kind: "agent.hook",
    source: { app: "hook", instanceId: "verify-hook", pid: process.pid },
    scope: { terminalSessionId: "terminal-verify" },
    payload: { source: "codex" },
  };
}

export function validAgentCompletionEvent() {
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

export function assertUnauthorizedWebSocket(url, token) {
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

export function assertPolicyCloseWebSocket(url, token) {
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

export async function getJson(url, token) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.ok, true);
  return response.json();
}

export function connectStream(url, token) {
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

export function connectCatchupStream(url, token, expectedEventCount) {
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

export function waitForMessage(stream, predicate) {
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
