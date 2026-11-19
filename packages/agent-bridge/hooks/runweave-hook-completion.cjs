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
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Runweave-Hook-Token": token,
      },
      body: JSON.stringify(body),
      ...(source === "claude" ? { signal: AbortSignal.timeout(5000), redirect: "error" } : {}),
    });
    const result = await response.json().catch(() => null);
    return { summary: result?.event?.payload?.summary, ok: response.ok, status: response.status, accepted: Boolean(result?.event || result?.notificationId) && !result?.ignored, notificationId: result?.notificationId ?? (result?.event?.payload?.completionRevision ? String(result.event.payload.completionRevision) : undefined) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

module.exports = { postCompletionHook, notifyFeishu, notifyFeishuOnWindows };
