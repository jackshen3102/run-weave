/* global fetch, module, require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { buildCompletionHookBody } = require("./runweave-hook-payload.cjs");

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
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Runweave-Hook-Token": token,
      },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, accepted: Boolean(result?.event || result?.notificationId) && !result?.ignored, notificationId: result?.notificationId ?? (result?.event?.payload?.completionRevision ? String(result.event.payload.completionRevision) : undefined) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

module.exports = { postCompletionHook };
