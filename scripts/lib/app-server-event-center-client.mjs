import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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

export async function verifyThreadPreviews(baseUrl, token, stateDir) {
  const codexId = "11111111-1111-4111-8111-111111111111";
  const sessions = path.join(stateDir, "codex-sessions");
  await mkdir(sessions, { recursive: true });
  const file = path.join(sessions, `${codexId}.jsonl`);
  const line = (value) => `${JSON.stringify(value)}\n`;
  const message = (role, text) => ({ type: "response_item", payload: {
    type: "message", role, phase: role === "assistant" ? "commentary" : undefined,
    content: [{ type: "output_text", text }],
  } });
  const hook = async (threadId, source, pi) => {
    const result = await postEvent(baseUrl, token, {
      ...validAgentHookEvent(),
      payload: { source, threadId, stateHookEvent: "UserPromptSubmit", ...(pi ? { pi } : {}) },
    });
    assert.equal(result.status, 201);
  };
  const read = async (id) => (await getJson(
    `${baseUrl}/threads/previews?threadId=${id}`, token)).previews[0];
  const wait = async (id, predicate) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const preview = await read(id);
      if (predicate(preview)) return preview;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`Preview did not converge: ${JSON.stringify(await read(id))}`);
  };
  await writeFile(file, line({ type: "session_meta", payload: { id: codexId } }) +
    line({ type: "event_msg", payload: { type: "task_started", turn_id: "first-turn" } }) +
    line(message("user", "**验证首页**")) +
    line(message("assistant", "正在测量读取开销。")) +
    line({ type: "response_item", payload: { type: "function_call", name: "raw-tool-name" } }).repeat(4000));
  await hook(codexId, "codex");
  assert.equal((await read(codexId)).available, false, "cold HTTP must return before backfill");
  const preview = await wait(codexId, (value) => value.available);
  assert.equal(preview.userText, "验证首页");
  assert.equal(preview.agentText, "正在测量读取开销。", "tool records cannot overwrite actual prose");
  await appendFile(file, line(message("assistant", "已完成采样。")));
  await wait(codexId, (value) => value.agentText === "已完成采样。");
  await hook(codexId, "codex");
  assert.equal((await read(codexId)).available, false, "new prompt must hide the previous turn immediately");
  // A hook can precede the native transcript append; an empty read must not reveal stale text.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await read(codexId)).available, false);
  const partial = JSON.stringify(message("user", "新的任务"));
  await appendFile(file, line({ type: "event_msg", payload: { type: "task_started", turn_id: "second-turn" } }) + partial.slice(0, 30));
  await appendFile(file, partial.slice(30) + "\n");
  const second = await wait(codexId, (value) => value.available && value.userText === "新的任务");
  assert.equal(second.agentText, null, "a new turn without commentary has no borrowed final reply");
  assert.equal(second.turnId, "second-turn");
  // A replaced/truncated transcript must discard its old projection and revalidate identity.
  await writeFile(file, line({ type: "session_meta", payload: { id: "different-thread" } }) + line(message("user", "错误归属")));
  await hook(codexId, "codex");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await read(codexId)).available, false);

  const piId = "22222222-2222-4222-8222-222222222222";
  const piFile = path.join(stateDir, "pi-preview.jsonl");
  const pi = { version: 1, sessionId: piId, sessionFile: piFile, instanceId: "preview-pi",
    startedAt: new Date().toISOString(), sequence: 1, runId: "pi-run", leafId: "a-reply",
    event: "user_message", outcome: null };
  const piMessage = (id, parentId, role, text) => ({ type: "message", id, parentId,
    message: { role, content: [{ type: "text", text }] } });
  await writeFile(piFile, [
    { type: "session", id: piId, version: 3 },
    piMessage("a-user", null, "user", "分支 A 的任务"),
    piMessage("a-reply", "a-user", "assistant", "分支 A 的回复"),
    { type: "custom", id: "anchor-a", parentId: "a-reply", customType: "runweave.lifecycle", data: pi },
    piMessage("b-user", null, "user", "分支 B 的任务"),
    piMessage("b-reply", "b-user", "assistant", "分支 B 的回复"),
  ].map(line).join(""));
  await hook(piId, "pi", pi);
  const branchA = await wait(piId, (value) => value.available);
  assert.equal(branchA.userText, "分支 A 的任务");
  assert.equal(branchA.agentText, "分支 A 的回复");
  const nextPi = { ...pi, sequence: 2, leafId: "b-reply", event: "session_tree" };
  await appendFile(piFile, line({ type: "custom", id: "anchor-b", parentId: "b-reply",
    customType: "runweave.lifecycle", data: nextPi }) +
    line(piMessage("tool-result", "anchor-b", "toolResult", "不可读的工具输出")));
  await hook(piId, "pi", nextPi);
  const branchB = await wait(piId, (value) => value.available);
  assert.equal(branchB.userText, "分支 B 的任务");
  assert.equal(branchB.agentText, "分支 B 的回复");
  await assertHttpStatus(`${baseUrl}/threads/previews?threadId=${piId}`, { expectedStatus: 401 });
  console.log("thread previews: incremental append, current turn, identity, Pi branch and auth passed");
}
