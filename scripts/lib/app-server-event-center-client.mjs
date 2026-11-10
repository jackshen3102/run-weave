import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
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
  const unregisteredId = "33333333-3333-4333-8333-333333333333";
  await writeFile(path.join(sessions, `${unregisteredId}.jsonl`),
    line({ type: "session_meta", payload: { id: unregisteredId } }) +
    line(message("user", "没有 Hook 的真实输入")) + line(message("assistant", "可核验的真实回复")));
  await hook(codexId, "codex");
  assert.equal((await read(codexId)).available, false, "cold HTTP must return before backfill");
  const preview = await wait(codexId, (value) => value.available);
  assert.equal(preview.userText, "验证首页");
  assert.equal(preview.agentText, "正在测量读取开销。", "tool records cannot overwrite actual prose");
  await appendFile(file, line(message("assistant", "已完成采样。")));
  await wait(codexId, (value) => value.agentText === "已完成采样。");
  await hook(codexId, "codex");
  assert.equal((await read(codexId)).available, true, "a late hook must not hide already-read latest messages");
  // A hook can precede or follow the native append. The transcript remains the text authority.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await read(codexId)).agentText, "已完成采样。");
  const partial = JSON.stringify(message("user", "新的任务"));
  await appendFile(file, line({ type: "event_msg", payload: { type: "task_started", turn_id: "second-turn" } }) + partial.slice(0, 30));
  await appendFile(file, partial.slice(30) + "\n");
  const second = await wait(codexId, (value) => value.available && value.userText === "新的任务");
  assert.equal(second.agentText, null, "a new turn without commentary has no borrowed final reply");
  assert.equal(second.turnId, "second-turn");
  await hook(codexId, "codex");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await read(codexId)).userText, "新的任务", "a late submit must not hide the new turn");
  const recoverySource = await readFile(file);
  await unlink(file);
  await hook(codexId, "codex");
  await wait(codexId, (value) => value.availability === "source_missing");
  await writeFile(file, recoverySource);
  await hook(codexId, "codex");
  await wait(codexId, (value) => value.available && value.userText === "新的任务");
  // A replaced/truncated transcript must discard its old projection and revalidate identity.
  await writeFile(file, line({ type: "session_meta", payload: { id: "different-thread" } }) + line(message("user", "错误归属")));
  await hook(codexId, "codex");
  const invalid = await wait(codexId, (value) => value.availability === "source_missing");
  assert.equal(invalid.available, false);

  const unregistered = await wait(unregisteredId, (value) => value.available);
  assert.equal(unregistered.userText, "没有 Hook 的真实输入");
  assert.equal(unregistered.agentText, "可核验的真实回复");
  await appendFile(path.join(sessions, `${unregisteredId}.jsonl`),
    line(message("user", "未注册会话继续")) + line(message("assistant", "预览继续刷新")));
  await wait(unregisteredId, (value) => value.userText === "未注册会话继续" && value.agentText === "预览继续刷新");
  await assertHttpStatus(`${baseUrl}/threads/${unregisteredId}`, { expectedStatus: 404, token });
  const missing = await wait("44444444-4444-4444-8444-444444444444", (value) => value.availability === "source_missing");
  assert.equal(missing.available, false);

  const traeId = "55555555-5555-4555-8555-555555555555";
  const traeRoot = path.join(stateDir, "trae-sessions");
  await mkdir(traeRoot, { recursive: true });
  const traeFile = path.join(traeRoot, `${traeId}.jsonl`);
  const mutation = (items) => ({ type: "history_mutation", payload: { version: 1, operation: "append", items } });
  await writeFile(traeFile, [
    { type: "session_meta", payload: { id: traeId } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "trae-turn" } },
    mutation([message("user", "Trae 真实任务").payload, message("assistant", "Trae 真实回复").payload]),
    mutation([{ type: "function_call_output", output: "不展示工具输出" }]),
  ].map(line).join(""));
  await hook(traeId, "traex");
  const trae = await wait(traeId, (value) => value.available);
  assert.equal(trae.userText, "Trae 真实任务");
  assert.equal(trae.agentText, "Trae 真实回复");
  await appendFile(traeFile, line(mutation([message("user", "Trae 下一轮").payload])));
  await hook(traeId, "traex");
  const traeNext = await wait(traeId, (value) => value.userText === "Trae 下一轮");
  assert.equal(traeNext.agentText, null);
  await verifyTraeConversation(baseUrl, token, traeRoot, hook);

  await verifyClaudeConversation(baseUrl, token, stateDir, hook, wait);
  await hook("unsupported-provider", "unknown");
  const unsupported = await wait("unsupported-provider", (value) => value.availability === "provider_unsupported");
  assert.equal(unsupported.available, false);

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
  console.log("thread previews: late hooks, unregistered Codex, Trae messages, incremental append, identity, Pi branch and auth passed");
}

async function verifyClaudeConversation(baseUrl, token, stateDir, hook, wait) {
  const id = "77777777-7777-4777-8777-777777777777";
  const root = path.join(stateDir, "claude-config", "projects");
  const project = path.join(root, "controlled-project");
  const file = path.join(project, `${id}.jsonl`);
  const cwd = path.join(stateDir, "controlled-workspace");
  const url = `${baseUrl}/threads/${id}/conversation`;
  const line = value => `${JSON.stringify(value)}\n`;
  const msg = (uuid, parentUuid, role, content, extra = {}) => ({ type: role, uuid, parentUuid,
    sessionId: id, cwd, isSidechain: false, timestamp: "2026-11-10T00:00:00.000Z",
    message: { role, content: typeof content === "string" ? [{ type: "text", text: content }] : content }, ...extra });
  const original = [
    { type: "file-history-snapshot", messageId: "u1", snapshot: {}, isSnapshotUpdate: false },
    msg("u1", null, "user", "**Claude 原生提问**"),
    // Sanitized CLI 2.1.319 shape: attachments are graph ancestors, not visible messages.
    { type: "attachment", uuid: "environment", parentUuid: "u1", sessionId: id, cwd, isSidechain: false,
      attachment: { type: "environment" }, rendered: [{ content: "PRIVATE_ENVIRONMENT" }], renderedRole: "system" },
    { type: "attachment", uuid: "snapshot", parentUuid: "environment", sessionId: id, cwd, isSidechain: false,
      attachment: { type: "prompt_snapshot", systemPrompt: ["PRIVATE_PROMPT_SNAPSHOT"] } },
    msg("a1", "snapshot", "assistant", [
      { type: "thinking", thinking: "PRIVATE_THINKING", signature: "PRIVATE_SIGNATURE" },
      { type: "text", text: "可见的进度" }, { type: "tool_use", id: "tool-1", name: "Read", input: { secret: "PRIVATE_TOOL" } },
    ]),
    msg("tool", "a1", "user", [{ type: "tool_result", tool_use_id: "tool-1", content: "PRIVATE_TOOL_RESULT" },
      { type: "text", text: "PRIVATE_TOOL_ANNOTATION" }]),
    msg("meta", "tool", "user", "PRIVATE_SYSTEM_INJECTION", { isMeta: true }),
    msg("a2", "meta", "assistant", "# 完整回答\n\n" + "保留原文。".repeat(2000)),
    msg("a2", "meta", "assistant", "# 完整回答\n\n" + "保留原文。".repeat(2000)),
    { type: "system", subtype: "turn_duration", uuid: "system", parentUuid: "a2", sessionId: id, cwd, content: "PRIVATE_SYSTEM" },
    msg("side-u", null, "user", "PRIVATE_SUBAGENT", { isSidechain: true }),
    msg("side-a", "side-u", "assistant", "PRIVATE_SUBAGENT", { isSidechain: true }),
    { type: "progress", uuid: "progress", parentUuid: "system", sessionId: id, data: { message: "PRIVATE_NESTED" } },
    msg("discarded", "u1", "user", "PRIVATE_DISCARDED_BRANCH"),
    { type: "last-prompt", sessionId: id, leafUuid: "system", lastPrompt: "PRIVATE_DUPLICATE_PROMPT" },
  ].map(line).join("");
  await mkdir(project, { recursive: true });
  await writeFile(file, original);
  const historical = await getJson(`${url}?provider=claude`, token);
  assert.equal(historical.availability, "available", "native history can outlive hook retention");
  await assertHttpStatus(`${baseUrl}/threads/${id}`, { expectedStatus: 404, token });
  await hook(id, "claude");
  const threadBefore = (await getJson(`${baseUrl}/threads/${id}`, token)).thread;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.provider, "claude");
  assert.equal(body.availability, "available");
  assert.equal(body.partial, false);
  assert.deepEqual(body.turns.flatMap(turn => turn.messages.map(message => message.id)), ["u1", "a1", "a2"]);
  assert.equal(body.turns[0].messages[2].text.length, 10008);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_|sourcePath/);
  assert.deepEqual((await getJson(url, token)).turns, body.turns);
  assert.equal(await readFile(file, "utf8"), original, "native transcript must remain read-only");
  const preview = await wait(id, value => value.available);
  assert.equal(preview.userText, "Claude 原生提问");
  assert.ok(preview.agentText.startsWith("完整回答"));
  const detail = await getJson(`${baseUrl}/threads/${id}/detail`, token);
  assert.equal(detail.availability, "available");
  assert.equal(detail.detail.status, "unknown");
  assert.deepEqual(detail.detail.lifecycle, []);
  assert.deepEqual(detail.detail.turns, [], "native text must not manufacture completed turns");
  assert.deepEqual((await getJson(`${baseUrl}/threads/${id}`, token)).thread, threadBefore,
    "reading text must not write lifecycle state or completion events");

  // Latest main-chain leaf selects only its ancestors, never concatenates sibling branches.
  await appendFile(file, line(msg("branch-u", "u1", "user", "新分支提问")) +
    line(msg("branch-a", "branch-u", "assistant", "新分支回答")));
  assert.deepEqual((await getJson(url, token)).turns.flatMap(t => t.messages.map(m => m.id)), ["u1", "branch-u", "branch-a"]);
  const pending = JSON.stringify(msg("pending", "branch-a", "user", "完整末行"));
  await appendFile(file, pending);
  assert.equal((await getJson(url, token)).turns.at(-1).id, "branch-u");
  await appendFile(file, "\nBROKEN_JSON\n");
  const partial = await getJson(url, token);
  assert.equal(partial.partial, true);
  assert.equal(partial.turns.at(-1).id, "pending");
  await hook(id, "claude");
  const next = await wait(id, value => value.userText === "完整末行");
  assert.equal(next.agentText, null, "a new user turn cannot borrow a previous answer");
  await appendFile(file, line({ type: "system", subtype: "compact_boundary", uuid: "compact",
    parentUuid: null, logicalParentUuid: "pending", sessionId: id, cwd }) +
    line(msg("summary", "compact", "user", "PRIVATE_COMPACT_SUMMARY", { isCompactSummary: true })) +
    line(msg("after-compact", "summary", "assistant", "压缩后继续")));
  const compacted = await getJson(url, token);
  assert.deepEqual(compacted.turns.flatMap(t => t.messages.map(m => m.id)), ["u1", "branch-u", "branch-a", "pending", "after-compact"]);
  assert.doesNotMatch(JSON.stringify(compacted), /PRIVATE_COMPACT/);

  // CLI 2.1.319 manual compaction may point at an unpersisted command node.
  // The retained segment, not the latest sibling, identifies original prose.
  const nativeCompact = (segment = {}) => original + [
    { type: "system", subtype: "compact_boundary", uuid: "native-compact", parentUuid: null,
      logicalParentUuid: "not-persisted", sessionId: id, cwd, compactMetadata: {
        preservedSegment: { headUuid: "a1", tailUuid: "system", anchorUuid: "native-summary", ...segment },
        preservedMessages: { anchorUuid: "native-summary", uuids: ["a1", "a2", "system"] },
      } },
    msg("native-summary", "native-compact", "user", "PRIVATE_COMPACT_SUMMARY", { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    msg("native-command", "native-summary", "user", "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>PRIVATE_COMMAND</command-args>"),
    msg("native-stdout", "native-command", "user", "<local-command-stdout>PRIVATE_STDOUT</local-command-stdout>"),
    msg("native-repeat", "native-stdout", "user", "PRIVATE_REPEAT_SUMMARY", { repeatsCompactSummary: true }),
    msg("native-user", "native-repeat", "user", "请解释 <local-command-stdout>quoted</local-command-stdout>，不要执行。"),
    msg("native-answer", "native-user", "assistant", "压缩后原生回答"),
  ].map(line).join("");
  await writeFile(file, nativeCompact());
  const retained = await getJson(url, token);
  assert.equal(retained.partial, false);
  assert.deepEqual(retained.turns.flatMap(t => t.messages.map(m => m.id)), ["u1", "a1", "a2", "native-user", "native-answer"]);
  assert.doesNotMatch(JSON.stringify(retained), /PRIVATE_|<command-name>|<command-message>|<command-args>/);
  assert.match(retained.turns.at(-1).messages[0].text, /<local-command-stdout>quoted<\/local-command-stdout>/,
    "ordinary discussion of native tags remains visible");
  await hook(id, "claude");
  assert.equal((await wait(id, value => value.agentText === "压缩后原生回答")).available, true);
  for (const segment of [{ headUuid: "discarded" }, { tailUuid: "missing" }, { anchorUuid: "other-summary" }]) {
    await writeFile(file, nativeCompact(segment));
    const incomplete = await getJson(url, token);
    assert.equal(incomplete.partial, true);
    assert.deepEqual(incomplete.turns.flatMap(t => t.messages.map(m => m.id)), ["native-user", "native-answer"],
      "unverified retained history must not borrow another branch");
  }
  await assertHttpStatus(url, { expectedStatus: 401 });
  await assertHttpStatus(`${url}?sourcePath=${encodeURIComponent(file)}`, { expectedStatus: 400, token });
  await assertHttpStatus(`${url}?provider=codex`, { expectedStatus: 409, token });
  await assertHttpStatus(`${baseUrl}/threads/${encodeURIComponent("../escape")}/conversation?provider=claude`, { expectedStatus: 404, token });

  await writeFile(file, original.replaceAll(`"sessionId":"${id}"`, '"sessionId":"wrong-session"'));
  await assertHttpStatus(url, { expectedStatus: 409, token });
  await assertHttpStatus(`${baseUrl}/threads/${id}`, { expectedStatus: 409, token });
  await assertHttpStatus(`${baseUrl}/threads/${id}/detail`, { expectedStatus: 409, token });
  await hook(id, "claude");
  await wait(id, value => !value.available && value.availability === "read_failed");
  await writeFile(file, "BROKEN_JSON\n");
  await assertHttpStatus(url, { expectedStatus: 422, token });
  await writeFile(file, original);
  const duplicate = path.join(root, "other-project", `${id}.jsonl`);
  await mkdir(path.dirname(duplicate), { recursive: true });
  await writeFile(duplicate, original);
  await assertHttpStatus(url, { expectedStatus: 409, token });
  await unlink(duplicate);
  // CWD comes only from the registered target, never from a client-supplied path.
  const scoped = await postEvent(baseUrl, token, { ...validAgentHookEvent(),
    scope: { terminalSessionId: "terminal-verify", cwd: path.join(stateDir, "wrong-workspace") },
    payload: { source: "claude", threadId: id, stateHookEvent: "UserPromptSubmit" } });
  assert.equal(scoped.status, 201);
  await assertHttpStatus(url, { expectedStatus: 409, token });
  await postEvent(baseUrl, token, { ...validAgentHookEvent(), scope: { terminalSessionId: "terminal-verify", cwd },
    payload: { source: "claude", threadId: id, stateHookEvent: "UserPromptSubmit" } });
  assert.equal((await getJson(url, token)).availability, "available");
  await unlink(file);
  assert.equal((await getJson(url, token)).availability, "source_missing");
  const external = path.join(stateDir, "external-claude.jsonl");
  await writeFile(external, original);
  await symlink(external, file);
  await assertHttpStatus(url, { expectedStatus: 409, token });
  await unlink(file);
  await unlink(external);
  const subagentFile = path.join(project, id, "subagents", `${id}.jsonl`);
  await mkdir(path.dirname(subagentFile), { recursive: true });
  await writeFile(subagentFile, original);
  assert.equal((await getJson(url, token)).availability, "source_missing", "subagent directories are never searched");

  // Keep the latest complete native messages even when their ancestors left the source window.
  await writeFile(file, line(msg("old", null, "user", "窗口外提问")));
  await appendFile(file, " ".repeat(65 * 1024 * 1024) + "\n" +
    line(msg("tail-u", "outside-window", "user", "末尾提问")) + line(msg("tail-a", "tail-u", "assistant", "最新回答")));
  const bounded = await getJson(url, token);
  assert.equal(bounded.partial, true);
  assert.deepEqual(bounded.turns.flatMap(t => t.messages.map(m => m.id)), ["tail-u", "tail-a"]);
  await writeFile(file, line(msg("huge-u", null, "user", "超长正文")) +
    line(msg("huge-a", "huge-u", "assistant", "中😀\"\n".repeat(1_100_000) + "CLAUDE_LATEST_MARKER")));
  const hugeBytes = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).text();
  const huge = JSON.parse(hugeBytes);
  assert.equal(huge.partial, true);
  assert.ok(Buffer.byteLength(hugeBytes) < 8 * 1024 * 1024);
  assert.ok(huge.turns.at(-1).messages.at(-1).text.endsWith("CLAUDE_LATEST_MARKER"));
  await unlink(file);
  console.log("Claude native conversation: filtering, branch/UUID stability, incomplete append, compaction, identity/CWD, ambiguity, symlinks, bounds, preview/detail, read-only state and auth passed");
}

async function verifyTraeConversation(baseUrl, token, root, hook) {
  const id = "66666666-6666-4666-8666-666666666666";
  const file = path.join(root, `${id}.jsonl`);
  const url = `${baseUrl}/threads/${id}/conversation`;
  const line = value => `${JSON.stringify(value)}\n`;
  const msg = (id, role, text, phase) => ({ type: "message", id, role, phase,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }] });
  const mutation = (items, extra = {}) => ({ type: "history_mutation",
    payload: { version: 1, operation: "append", items, ...extra } });
  const original = [
    { type: "session_meta", payload: { id } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "trae-read-turn" } },
    mutation([
      msg("env", "user", "<environment_context>private</environment_context>"),
      msg("u1", "user", "**真实提问**"),
      msg("a1", "assistant", "可见阶段", "commentary"),
      msg("hidden", "assistant", "PRIVATE_ANALYSIS", "analysis"),
      msg("system", "developer", "PRIVATE_SYSTEM"),
      { type: "function_call_output", output: "PRIVATE_TOOL" },
      msg("a2", "assistant", "# 长回答\n\n" + "完整正文。".repeat(2000), "final_answer"),
      msg("a2", "assistant", "DUPLICATE", "final_answer"),
      msg("u2", "user", "相同提问"), msg("u3", "user", "相同提问"),
    ]),
    mutation([msg("summary", "user", "COMPACTED_SUMMARY"), msg("rewritten", "assistant", "REGENERATED")],
      { operation: "replace", compaction_response_id: "compaction-1" }),
    mutation([msg("a3", "assistant", "压缩后继续回答", "final_answer")]),
  ].map(line).join("");
  await writeFile(file, original);
  for (const provider of ["traex", "trae", "traecli"]) {
    await hook(id, provider);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.provider, provider);
    assert.equal(body.availability, "available");
    assert.equal(body.partial, false);
    assert.deepEqual(body.turns.flatMap(turn => turn.messages.map(message => message.id)), ["u1", "a1", "a2", "u2", "u3", "a3"]);
    assert.equal(body.turns[0].messages[2].text.length, 10007);
    assert.equal(body.turns[0].rawTurnId, "trae-read-turn");
    assert.equal(body.turns[0].messages[2].phase, "final");
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_|COMPACTED_SUMMARY|REGENERATED|DUPLICATE|sourcePath/);
    assert.deepEqual((await getJson(url, token)).turns, body.turns);
  }
  assert.equal(await readFile(file, "utf8"), original, "reading cannot change the source");
  const pending = line(mutation([msg("pending", "user", "完成末行")])).trimEnd();
  await appendFile(file, pending);
  assert.equal((await getJson(url, token)).turns.flatMap(t => t.messages).length, 6);
  await appendFile(file, "\nBROKEN_JSON\n");
  const partial = await getJson(url, token);
  assert.equal(partial.partial, true);
  assert.equal(partial.turns.at(-1).messages[0].id, "pending");
  await appendFile(file, line(mutation([msg("reset-u", "user", "重写后的历史"), msg("reset-a", "assistant", "重写后的回答")], { operation: "replace" })));
  assert.deepEqual((await getJson(url, token)).turns.flatMap(t => t.messages.map(m => m.id)), ["reset-u", "reset-a"]);
  await assertHttpStatus(url, { expectedStatus: 401 });
  await assertHttpStatus(`${url}?sourcePath=${encodeURIComponent(file)}`, { expectedStatus: 400, token });
  await writeFile(file, original.replace(`"id":"${id}"`, '"id":"wrong-thread"'));
  assert.equal((await getJson(url, token)).availability, "source_missing");
  await unlink(file);
  assert.equal((await getJson(url, token)).availability, "source_missing");
  const external = path.join(root, "external.jsonl");
  await writeFile(external, original);
  await symlink(external, file);
  assert.equal((await getJson(url, token)).availability, "source_missing");
  await unlink(file);
  await unlink(external);
  // A bounded tail must retain the authoritative header and the newest complete messages.
  await writeFile(file, line({ type: "session_meta", payload: { id } }));
  await appendFile(file, " ".repeat(65 * 1024 * 1024) + "\n" + line(mutation([
    msg("tail-u", "user", "末尾提问"), msg("tail-a", "assistant", "最新回答", "final_answer"),
  ])));
  const bounded = await getJson(url, token);
  assert.equal(bounded.partial, true);
  assert.deepEqual(bounded.turns.flatMap(t => t.messages.map(m => m.id)), ["tail-u", "tail-a"]);
  await writeFile(file, line({ type: "session_meta", payload: { id } }) + line(mutation([
    msg("huge-u", "user", "超长正文"), msg("huge-a", "assistant", "中😀\"\n".repeat(1_100_000) + "LATEST_MARKER", "final_answer"),
  ])));
  const hugeResponse = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const hugeBytes = await hugeResponse.text();
  const huge = JSON.parse(hugeBytes);
  assert.equal(huge.partial, true);
  assert.ok(Buffer.byteLength(hugeBytes) < 8 * 1024 * 1024);
  assert.ok(huge.turns.at(-1).messages.at(-1).text.endsWith("LATEST_MARKER"));
  await unlink(file);
  console.log("Trae conversation: aliases, full prose, filtering, deduplication, compaction, rewrites, stable IDs, partial append, identity, symlinks, bounded source/response and auth passed");
}
