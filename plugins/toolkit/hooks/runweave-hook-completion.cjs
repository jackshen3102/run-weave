/* global fetch, module, require, AbortSignal */
/* eslint-disable @typescript-eslint/no-require-imports */
const { buildCompletionHookBody, extractUserPrompt, isFeishuAttentionHook, readNotificationType } = require("./runweave-hook-payload.cjs");
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

module.exports = { postCompletionHook };
