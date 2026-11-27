/* global fetch, module, require, process, AbortSignal */
/* eslint-disable @typescript-eslint/no-require-imports */
const { buildCompletionHookBody, extractCompletionSummary, parsePayload, extractUserPrompt, isFeishuAttentionHook, readNotificationType } = require("./runweave-hook-payload.cjs");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

function notifyFeishu(payload, source, terminalSessionId, terminalPanelId, bridgePath) {
  if (process.env.RUNWEAVE_HOOK_SUPPRESS_FEISHU_NOTIFY === "1") return;
  const windows = process.platform === "win32";
  const script = windows ? bridgePath : path.join(path.dirname(bridgePath), "feishu_stop_notify.sh");
  try {
    if (!fs.existsSync(script)) {
      return;
    }
    const child = spawn(windows ? process.execPath : script, windows ? [script, "--feishu-notify-worker"] : [], {
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
      env: { ...process.env, RUNWEAVE_HOOK_NODE: process.execPath, ...(windows ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    });
    child.on("error", () => {});
    child.stdin.end(
      JSON.stringify({
        ...payload,
        last_assistant_message: extractCompletionSummary(payload),
        source,
        terminalSessionId,
        terminalPanelId: terminalPanelId || undefined,
        projectId: process.env.RUNWEAVE_PROJECT_ID || undefined,
      }),
    );
    child.unref();
  } catch {
    // Ignore Feishu notification failures.
  }
}


async function notifyFeishuOnWindows(input) {
  const root = process.env.RUNWEAVE_RUNTIME_CONFIG_ROOT;
  const instance = process.env.RUNWEAVE_RUNTIME_INSTANCE_ID;
  if (!root || !instance) return;
  const payload = parsePayload(input);
  const event = payload.hook_event_name ?? payload.hookEventName ?? payload.event;
  if (event && String(event).toLowerCase() !== "stop") return;
  const logFailure = (message) => {
    try {
      fs.appendFileSync(path.join(root, "runtime", "feishu-notify.log"), `${new Date().toISOString()} app notify failed: ${message}\n`);
    } catch { /* Notification failures must not interrupt the Agent. */ }
  };
  let runner = path.join(root, "runtime", "bin", "bound-cli.cjs");
  // Standalone Server owns this Stable launcher; never search a global CLI or another instance.
  if (!fs.existsSync(runner) && instance === "stable") runner = path.join(root, "server", "rw.cjs");
  if (!fs.existsSync(runner)) {
    logFailure("bound CLI not found");
    return;
  }
  const summary = extractCompletionSummary(payload) || "(任务已完成)";
  const characters = Array.from(summary);
  const content = characters.length > 2500 ? `${characters.slice(0, 2500).join("")}\n...(truncated)` : summary;
  const cwd = payload.cwd || process.cwd();
  const result = spawnSync(process.execPath, [runner, "feishu", "notify", "--stdin", "--json"], {
    input: JSON.stringify({ ...payload, notificationText: `路径: ${cwd}(${payload.terminalSessionId})\n\n${content}` }),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 90_000,
    windowsHide: true,
  });
  if (result.status !== 0) logFailure(result.error?.code ?? `CLI exit ${result.status}`);
}


const { setTimeout } = require("node:timers");

async function postAgentHook({
  endpoint,
  token,
  terminalSessionId,
  projectId,
  agent,
  hookEvent,
  threadId,
  turnId,
  panelId,
  tmuxPaneId,
  commandName,
  rawHookEvent,
  sessionSource,
  query,
  assistantResponse,
  toolHook,
  activityEventId,
  operationId,
  pi,
  claude,
  agy,
}) {
  let body = JSON.stringify({
    activityEventId,
    ...(pi ? { pi } : {}),
    ...(claude ? { claude } : {}),
    ...(agy ? { agy } : {}),
    ...(operationId ? { operationId } : {}),
    terminalSessionId,
    projectId,
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(panelId ? { panelId } : {}),
    ...(tmuxPaneId ? { tmuxPaneId } : {}),
    commandName: commandName || null,
    rawHookEvent: String(rawHookEvent || hookEvent),
    ...(sessionSource ? { sessionSource } : {}),
    ...(query ? { query } : {}),
    ...(assistantResponse ? { response: assistantResponse } : {}),
    ...(toolHook?.toolUseId ? { toolUseId: toolHook.toolUseId } : {}),
    ...(toolHook?.toolName ? { toolName: toolHook.toolName } : {}),
    ...(toolHook?.toolInput !== undefined
      ? { toolInput: toolHook.toolInput }
      : {}),
    ...(toolHook?.toolResult !== undefined
      ? { toolResult: toolHook.toolResult }
      : {}),
    ...(hookEvent === "ToolCompleted" && toolHook?.toolExecution
      ? { toolExecution: toolHook.toolExecution }
      : {}),
    agent,
    hookEvent,
  });
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Runweave-Hook-Token": token,
        },
        body,
      });
      if (response.status === 400 && attempt === 1 && (turnId || toolHook?.toolExecution)) {
        const error = await response.json().catch(() => null);
        const rejected = error?.errors?.formErrors ?? [];
        const legacyField = turnId ? "turnId" : "toolExecution";
        if (rejected.includes(`Unrecognized key(s) in object: '${legacyField}'`)) {
          // Older Backends reject unknown fields. Preserve the tool event and
          // its content there, leaving the outcome unknown until they upgrade.
          const legacy = JSON.parse(body);
          delete legacy[legacyField];
          body = JSON.stringify(legacy);
          continue;
        }
      }
      if (response.ok || response.status < 500 || attempt === 2) {
        return { ok: response.ok, status: response.status, attempt };
      }
      lastError = new Error(`hook_endpoint_${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    ok: false,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

async function postCompletionHook({
  endpoint,
  token,
  terminalSessionId,
  payload,
  source,
  completionReason,
  rawEvent,
  commandName,
}) {
  const body = buildCompletionHookBody({
    terminalSessionId,
    payload,
    source,
    completionReason,
    rawEvent,
    commandName,
  });
  if (source === "claude") {
    if (!endpoint) return { accepted: false };
    const instanceId = payload.claude?.instanceId;
    if (!instanceId || payload.agent_id || payload.agent_transcript_path) return { accepted: false };
    const notificationType = readNotificationType(payload);
    const event = String(rawEvent).toLowerCase().replace(/[_\s-]/g, "");
    body.claude = { instanceId, eventId: payload.runweaveHookEventId,
      ...(notificationType ? { notificationType } : {}),
      ...(event === "userpromptsubmit" ? { query: extractUserPrompt(payload) || "" } : {}) };
    body.completionReason = event === "permissionrequest" ||
      (notificationType !== "idle_prompt" && isFeishuAttentionHook(payload, source)) ? "notify" : "hook_stop";
  }
  try {
    let response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Runweave-Hook-Token": token,
      },
      body: JSON.stringify(body),
      ...(source === "claude" ? { signal: AbortSignal.timeout(5000), redirect: "error" } : {}),
    });
    if (response.status === 400 && body.notificationType) {
      const error = await response.json().catch(() => null);
      if ((error?.errors?.formErrors ?? []).includes("Unrecognized key(s) in object: 'notificationType'")) {
        const legacy = { ...body };
        delete legacy.notificationType;
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Runweave-Hook-Token": token },
          body: JSON.stringify(legacy),
          ...(source === "claude" ? { signal: AbortSignal.timeout(5000), redirect: "error" } : {}),
        });
      } else {
        return { summary: error?.event?.payload?.summary, ok: false, status: response.status, accepted: false };
      }
    }
    const result = await response.json().catch(() => null);
    return { summary: result?.event?.payload?.summary, ok: response.ok, status: response.status, accepted: Boolean(result?.event || result?.notificationId) && !result?.ignored, notificationId: result?.notificationId ?? (result?.event?.payload?.completionRevision ? String(result.event.payload.completionRevision) : undefined) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

module.exports = { postAgentHook, postCompletionHook, notifyFeishu, notifyFeishuOnWindows };
