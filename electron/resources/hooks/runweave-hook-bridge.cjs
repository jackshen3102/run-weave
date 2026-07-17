#!/usr/bin/env node
/* global fetch, process, require, URL */
/* eslint-disable @typescript-eslint/no-require-imports */

const { spawn, spawnSync } = require("node:child_process");
const { setTimeout } = require("node:timers");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  STOP_EVENTS,
  buildAppServerBaseEvent,
  buildCompletionHookBody,
  deriveAgentHookEndpoint,
  deriveCompletionEndpoint,
  extractCompletionSummary,
  extractToolHook,
  extractUserPrompt,
  normalizeEventName,
  normalizeReason,
  normalizeSource,
  parseTmuxSocketPath,
  parseArgs,
  parsePayload,
  readHookEvent,
  readTmuxPaneContext,
  readThreadId,
  toAgentHookStateEvent,
} = require("./runweave-hook-payload.cjs");
const {
  discoverAppServer,
  postAppServerEvent,
} = require("./app-server-client.cjs");

function redactEndpoint(endpoint) {
  if (!endpoint) {
    return undefined;
  }
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[invalid endpoint]";
  }
}

function appendDebugLog(message, details) {
  const logPath = process.env.RUNWEAVE_HOOK_DEBUG_LOG;
  if (!logPath) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({
        at: new Date().toISOString(),
        source: "hook-bridge",
        message,
        details,
      })}\n`,
      "utf8",
    );
  } catch {
    // Ignore diagnostic logging failures.
  }
}

function readTmuxSessionEnv() {
  const sessionName = process.env.RUNWEAVE_TMUX_SESSION_NAME;
  const socketPath = parseTmuxSocketPath(process.env.TMUX);
  if (!sessionName || !socketPath) {
    return { refreshed: false, reason: "missing_tmux_env" };
  }

  const result = spawnSync(
    "tmux",
    ["-S", socketPath, "show-environment", "-t", sessionName],
    {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 256 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    return {
      refreshed: false,
      reason: "tmux_show_environment_failed",
      error: result.error instanceof Error ? result.error.message : undefined,
      status: result.status,
    };
  }

  const env = {};
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    if (line.startsWith("-RUNWEAVE_")) {
      delete process.env[line.slice(1)];
      continue;
    }
    if (!line.startsWith("RUNWEAVE_")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    env[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1);
  }

  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }

  return {
    refreshed: Object.keys(env).length > 0,
    sessionName,
    socketPath,
    keys: Object.keys(env).sort(),
  };
}

function notifyDesktop(source) {
  if (process.env.RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY === "1") {
    return;
  }
  if (process.platform !== "darwin") {
    return;
  }
  const labels = { claude: "Claude", codex: "Codex", trae: "Trae" };
  const name = labels[source] || "AI";
  try {
    spawn(
      "/usr/bin/osascript",
      ["-e", `display notification "回来接管终端" with title "${name} 完成了"`],
      { stdio: "ignore", detached: true },
    ).unref();
    spawn("/usr/bin/afplay", ["/System/Library/Sounds/Glass.aiff"], {
      stdio: "ignore",
      detached: true,
    }).unref();
  } catch {
    // Ignore desktop notification failures.
  }
}

function notifyFeishu(payload, source, terminalSessionId, terminalPanelId) {
  const script = `${os.homedir()}/.runweave/hooks/feishu_stop_notify.sh`;
  try {
    if (!fs.existsSync(script)) {
      return;
    }
    const child = spawn(script, [], {
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
    });
    child.on("error", () => {});
    child.stdin.end(
      JSON.stringify({
        ...payload,
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

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data);
    });
    process.stdin.resume();
  });
}

async function postAgentHook({
  endpoint,
  token,
  terminalSessionId,
  agent,
  hookEvent,
  threadId,
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
}) {
  const body = JSON.stringify({
    activityEventId,
    ...(operationId ? { operationId } : {}),
    terminalSessionId,
    projectId: process.env.RUNWEAVE_PROJECT_ID || undefined,
    ...(threadId ? { threadId } : {}),
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
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Runweave-Hook-Token": token,
      },
      body: JSON.stringify(body),
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const tmuxEnvRefresh = readTmuxSessionEnv();
  const args = parseArgs(process.argv.slice(2));
  const payload = parsePayload(await readStdin());
  const rawEvent = readHookEvent(payload);
  const normalizedEvent = normalizeEventName(rawEvent);
  const tmuxPaneContext = readTmuxPaneContext(spawnSync);
  if (tmuxPaneContext.panelId) {
    process.env.RUNWEAVE_TERMINAL_PANEL_ID = tmuxPaneContext.panelId;
  } else if (parseTmuxSocketPath(process.env.TMUX) && process.env.TMUX_PANE) {
    delete process.env.RUNWEAVE_TERMINAL_PANEL_ID;
  }
  const commandName = args.commandName || tmuxPaneContext.commandName;
  const normalizedCommandName = String(commandName || "").toLowerCase();
  let source = normalizeSource(args.source);
  if (source === "unknown") {
    if (["codex", "claude"].includes(normalizedCommandName)) {
      source = normalizedCommandName;
    } else if (["trae", "traecli", "traex"].includes(normalizedCommandName)) {
      source = "trae";
    }
  }
  const completionReason = normalizeReason(args.reason);
  const threadId = readThreadId(payload);
  const stateHookEvent =
    source === "codex" || source === "trae"
      ? toAgentHookStateEvent(normalizedEvent)
      : null;
  const toolHook = extractToolHook(payload);
  const shouldRecordCompletion =
    completionReason !== "hook_stop" || STOP_EVENTS.has(normalizedEvent);

  const endpoint = process.env.RUNWEAVE_HOOK_ENDPOINT;
  const stateEndpoint = deriveAgentHookEndpoint(endpoint);
  const completionEndpoint =
    process.env.RUNWEAVE_COMPLETION_HOOK_ENDPOINT ||
    deriveCompletionEndpoint(endpoint);
  const token = process.env.RUNWEAVE_HOOK_TOKEN;
  const terminalSessionId = process.env.RUNWEAVE_TERMINAL_SESSION_ID;
  const terminalPanelId = process.env.RUNWEAVE_TERMINAL_PANEL_ID || null;
  const tmuxPaneId = process.env.TMUX_PANE || null;
  appendDebugLog("hook bridge invoked", {
    rawEvent: String(rawEvent || "Unknown"),
    normalizedEvent,
    source,
    terminalSessionId: terminalSessionId || null,
    terminalPanelId,
    tmuxPaneId,
    tmuxPaneContext,
    projectId: process.env.RUNWEAVE_PROJECT_ID || null,
    hasToken: Boolean(token),
    endpoint: redactEndpoint(endpoint),
    stateEndpoint: redactEndpoint(stateEndpoint),
    completionEndpoint: redactEndpoint(completionEndpoint),
    threadId,
    stateHookEvent,
    commandName,
    shouldRecordCompletion,
    tmuxEnvRefresh,
  });
  // Only notify / report for completions inside a Runweave terminal. The hook
  // can be installed through AI CLI hook config or plugins, so without
  // this gate every AI CLI stop in any external terminal would trigger desktop
  // and Feishu notifications.
  if (!token || !terminalSessionId) {
    appendDebugLog("hook bridge skipped missing env", {
      rawEvent: String(rawEvent || "Unknown"),
      hasToken: Boolean(token),
      hasTerminalSessionId: Boolean(terminalSessionId),
      endpoint: redactEndpoint(endpoint),
      completionEndpoint: redactEndpoint(completionEndpoint),
    });
    return;
  }

  const appServerClient = await discoverAppServer();
  if (!appServerClient) {
    appendDebugLog("hook bridge app-server unavailable", {
      terminalSessionId,
    });
  } else {
    const result = await postAppServerEvent(
      appServerClient,
      buildAppServerBaseEvent({
        kind: "agent.hook",
        payload,
        rawEvent,
        normalizedEvent,
        stateHookEvent,
        source,
        terminalSessionId,
        threadId,
        commandName,
        dedupePrefix: "hook",
      }),
    );
    appendDebugLog("hook bridge posted app-server hook event", {
      terminalSessionId,
      ...result,
    });
    if (!result.ok) {
      appendDebugLog("hook bridge app-server post failed", {
        terminalSessionId,
        kind: "agent.hook",
        ...result,
      });
    }
  }

  if (stateHookEvent && stateEndpoint) {
    const activityEventId = crypto.randomUUID();
    const result = await postAgentHook({
      endpoint: stateEndpoint,
      token,
      terminalSessionId,
      agent: source,
      hookEvent: stateHookEvent,
      threadId,
      panelId: terminalPanelId,
      tmuxPaneId,
      commandName,
      rawHookEvent: rawEvent,
      sessionSource:
        payload.source === "startup" || payload.source === "resume"
          ? payload.source
          : undefined,
      query:
        stateHookEvent === "UserPromptSubmit"
          ? extractUserPrompt(payload)
          : undefined,
      assistantResponse:
        normalizedEvent === "stop"
          ? extractCompletionSummary(payload)
          : undefined,
      toolHook:
        stateHookEvent === "ToolRequested" || stateHookEvent === "ToolCompleted"
          ? toolHook
          : undefined,
      activityEventId,
      operationId: process.env.RUNWEAVE_TERMINAL_AGENT_OPERATION_ID || null,
    });
    appendDebugLog("hook bridge posted agent hook", {
      terminalSessionId,
      hookEvent: stateHookEvent,
      endpoint: redactEndpoint(stateEndpoint),
      ...result,
    });
  }

  if (shouldRecordCompletion && completionEndpoint) {
    notifyDesktop(source);
    notifyFeishu(payload, source, terminalSessionId, terminalPanelId);
    if (appServerClient) {
      const completionBody = buildCompletionHookBody({
        terminalSessionId,
        payload,
        source,
        completionReason,
        rawEvent,
        commandName,
      });
      const completionEvent = buildAppServerBaseEvent({
        kind: "agent.completion",
        payload,
        rawEvent,
        normalizedEvent,
        stateHookEvent,
        source,
        terminalSessionId,
        threadId,
        commandName,
        dedupePrefix: "completion",
      });
      completionEvent.payload = {
        source: completionBody.source,
        completionReason: completionBody.completionReason,
        commandName: completionBody.commandName,
        rawHookEvent: completionBody.rawHookEvent,
        hookEvent: completionBody.hookEvent,
        cwd: completionBody.cwd,
        summary: completionBody.summary,
        operationId: completionBody.operationId,
      };
      const result = await postAppServerEvent(appServerClient, completionEvent);
      appendDebugLog("hook bridge posted app-server completion event", {
        terminalSessionId,
        ...result,
      });
      if (!result.ok) {
        appendDebugLog("hook bridge app-server post failed", {
          terminalSessionId,
          kind: "agent.completion",
          ...result,
        });
      }
    }
    const result = await postCompletionHook({
      endpoint: completionEndpoint,
      token,
      terminalSessionId,
      payload,
      source,
      completionReason,
      rawEvent,
      commandName,
    });
    appendDebugLog("hook bridge posted completion hook", {
      terminalSessionId,
      rawEvent: String(rawEvent || "Stop"),
      endpoint: redactEndpoint(completionEndpoint),
      ...result,
    });
  }
}

main().catch((error) => {
  appendDebugLog("hook bridge failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 0;
});
