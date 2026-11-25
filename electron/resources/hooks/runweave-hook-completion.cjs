/* global fetch, module, require, AbortSignal */
/* eslint-disable @typescript-eslint/no-require-imports */
const { buildCompletionHookBody, extractUserPrompt, isFeishuAttentionHook, readNotificationType } = require("./runweave-hook-payload.cjs");
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
}) {
  let body = JSON.stringify({
    activityEventId,
    ...(pi ? { pi } : {}),
    ...(claude ? { claude } : {}),
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

module.exports = { postAgentHook, postCompletionHook };
