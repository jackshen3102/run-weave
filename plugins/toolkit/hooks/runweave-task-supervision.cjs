/* global AbortSignal, fetch, module, process, require, URL */
/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { extractUserPrompt } = require("./runweave-hook-payload.cjs");
async function requestSupervision({
  source,
  stateEndpoint,
  threadId,
  terminalPanelId,
  terminalSessionId,
  normalizedEvent,
  token,
  payload,
  hookStartedAt,
  debug = () => {},
}) {
  if (
    source === "codex" &&
    stateEndpoint &&
    threadId &&
    terminalPanelId &&
    process.env.RUNWEAVE_TERMINAL_AGENT_OPERATION_ID &&
    [
      "sessionstart",
      "userpromptsubmit",
      "interrupt",
      "stop",
      "permissionrequest",
      "pretooluse",
      "posttooluse",
    ].includes(normalizedEvent)
  ) {
    const supervisionEndpoint = new URL(
      "/internal/task-supervision",
      stateEndpoint,
    ).toString();
    const version = !["sessionstart", "userpromptsubmit", "stop"].includes(
      normalizedEvent,
    )
      ? null
      : spawnSync(
          process.env.RUNWEAVE_CODEX_EXECUTABLE ||
            process.env.RUNWEAVE_CODEX_BINARY ||
            "codex",
          ["--version"],
          {
            encoding: "utf8",
            timeout: 500,
            maxBuffer: 1024,
          },
        );
    const event = {
      sessionstart: "SessionStart",
      userpromptsubmit: "UserPromptSubmit",
      interrupt: "Interrupt",
      stop: "Stop",
      permissionrequest: "PermissionRequest",
      pretooluse: "PreToolUse",
      posttooluse: "PostToolUse",
    }[normalizedEvent];
    try {
      const response = await fetch(supervisionEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Runweave-Hook-Token": token,
        },
        signal: AbortSignal.timeout(
          normalizedEvent === "stop"
            ? Math.max(1, hookStartedAt + 110000 - Date.now())
            : 700,
        ),
        body: JSON.stringify({
          target: {
            terminalSessionId,
            panelId: terminalPanelId,
            threadId,
            executorGeneration:
              process.env.RUNWEAVE_TERMINAL_AGENT_OPERATION_ID,
          },
          event,
          ...(typeof payload.tool_name === "string"
            ? { toolName: payload.tool_name }
            : {}),
          hookVersion: 1,
          codexVersion: String(version?.stdout || "").trim(),
          ...(process.env.RUNWEAVE_CODEX_CONFIG_ARGS
            ? {
                executionConfig: {
                  binary:
                    process.env.RUNWEAVE_CODEX_EXECUTABLE ||
                    process.env.RUNWEAVE_CODEX_BINARY ||
                    "codex",
                  home:
                    process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
                  cwd: process.cwd(),
                  args: JSON.parse(process.env.RUNWEAVE_CODEX_CONFIG_ARGS),
                },
              }
            : {}),
          ...(typeof payload.model === "string"
            ? { executionModel: payload.model }
            : {}),
          rawTurnId: payload.turn_id || undefined,
          ...(normalizedEvent === "stop" &&
          typeof payload.last_assistant_message === "string"
            ? { reply: payload.last_assistant_message }
            : {}),
          ...(normalizedEvent === "userpromptsubmit"
            ? { prompt: extractUserPrompt(payload) }
            : {}),
          deadline:
            hookStartedAt + (normalizedEvent === "stop" ? 110000 : 1500),
        }),
      });
      debug("task supervision hook response", {
        event,
        status: response.status,
        version: String(version?.stdout || "").trim(),
      });
      if (response.ok)
        return { result: await response.json(), endpoint: supervisionEndpoint };
    } catch (error) {
      debug("task supervision hook unavailable", {
        event,
        error: error instanceof Error ? error.name : "unknown",
      });
      /* Allow native stop on unavailable supervision; never paste late input. */
    }
    // Interrupt has a native 3-second ceiling. It only invalidates decisions.
  }
  return null;
}
async function writeContinuation(offer, token) {
  const supervision = offer?.result;
  if (
    supervision?.action !== "request-continuation" ||
    !offer.endpoint ||
    Date.now() >= supervision.deadline - 1000
  )
    return;
  try {
    const response = await fetch(`${offer.endpoint}/validate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Runweave-Hook-Token": token,
      },
      signal: AbortSignal.timeout(700),
      body: JSON.stringify({
        watchId: supervision.watchId,
        decisionId: supervision.decisionId,
        revision: supervision.revision,
      }),
    });
    const result = response.ok ? await response.json() : null;
    if (result?.valid && Date.now() < supervision.deadline - 500)
      process.stdout.write(
        JSON.stringify({ decision: "block", reason: supervision.reason }),
      );
  } catch {
    /* Keep uncertain offers reserved; never replay. */
  }
}
module.exports = { requestSupervision, writeContinuation };
