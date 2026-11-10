/* global fetch, module, require, process, AbortSignal */
/* eslint-disable @typescript-eslint/no-require-imports */
const { buildCompletionHookBody, extractUserPrompt, isFeishuAttentionHook, readNotificationType } = require("./runweave-hook-payload.cjs");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const path = require("node:path");

function readClaudeInstance(spawnSync) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,comm="], {
    encoding: "utf8", timeout: 1000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  const processes = new Map();
  for (const line of String(result.stdout).split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (match) processes.set(Number(match[1]), { parent: Number(match[2]), command: path.basename(match[3]) });
  }
  let claudePid = null;
  const visited = new Set();
  for (let pid = process.ppid; pid > 1 && !visited.has(pid); ) {
    visited.add(pid);
    const entry = processes.get(pid);
    if (!entry) return null;
    if (["claude", "codex", "trae", "traex", "pi"].includes(entry.command)) {
      if (claudePid || entry.command !== "claude") return null;
      claudePid = pid;
    }
    pid = entry.parent;
  }
  if (!claudePid) return null;
  const started = spawnSync("ps", ["-p", String(claudePid), "-o", "lstart="], {
    encoding: "utf8", timeout: 1000,
  });
  const stamp = String(started.stdout || "").trim();
  return !started.error && started.status === 0 && stamp ? `${claudePid}:${stamp}` : null;
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
    const instanceId = readClaudeInstance(spawnSync);
    if (!instanceId || payload.agent_id || payload.agent_transcript_path) return { accepted: false };
    const notificationType = readNotificationType(payload);
    const event = String(rawEvent).toLowerCase().replace(/[_\s-]/g, "");
    body.claude = { instanceId, eventId: payload.runweaveHookEventId || randomUUID(),
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

module.exports = { postCompletionHook };
