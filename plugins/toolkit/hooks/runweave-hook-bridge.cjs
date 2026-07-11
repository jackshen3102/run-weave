#!/usr/bin/env node
/* global fetch, process, require, URL */
/* eslint-disable @typescript-eslint/no-require-imports */

const { spawn, spawnSync } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const {
  STOP_EVENTS,
  buildAppServerBaseEvent,
  buildCompletionHookBody,
  deriveAgentHookEndpoint,
  deriveCompletionEndpoint,
  normalizeEventName,
  normalizeReason,
  normalizeSource,
  parseArgs,
  parsePayload,
  readHookEvent,
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

function parseTmuxSocketPath(value) {
  if (!value) {
    return null;
  }
  const socketPath = String(value).split(",")[0]?.trim();
  return socketPath || null;
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

function getCommandBasename(command) {
  const normalized = String(command || "").trim().replace(/\\+/g, "/");
  if (!normalized) {
    return null;
  }
  const basename = normalized.split("/").filter(Boolean).at(-1) || normalized;
  return basename || null;
}

function readTmuxPaneCommandName() {
  const socketPath = parseTmuxSocketPath(process.env.TMUX);
  const tmuxPaneId = process.env.TMUX_PANE;
  if (!socketPath || !tmuxPaneId) {
    return null;
  }
  const separator = "__RUNWEAVE_METADATA_FIELD__";
  const result = spawnSync(
    "tmux",
    [
      "-S",
      socketPath,
      "display-message",
      "-p",
      "-t",
      tmuxPaneId,
      ["#{@runweave_command}", "#{pane_current_command}"].join(separator),
    ],
    {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 32 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    return null;
  }
  const [runweaveCommand = "", paneCommand = ""] = String(result.stdout || "")
    .replace(/\r?\n$/, "")
    .split(separator);
  return getCommandBasename(runweaveCommand) || getCommandBasename(paneCommand);
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
}) {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Runweave-Hook-Token": token,
      },
      body: JSON.stringify({
        terminalSessionId,
        projectId: process.env.RUNWEAVE_PROJECT_ID || undefined,
        ...(threadId ? { threadId } : {}),
        ...(panelId ? { panelId } : {}),
        ...(tmuxPaneId ? { tmuxPaneId } : {}),
        commandName: commandName || null,
        agent,
        hookEvent,
      }),
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
  const source = normalizeSource(args.source);
  const commandName = args.commandName || readTmuxPaneCommandName();
  const completionReason = normalizeReason(args.reason);
  const threadId = source === "codex" ? readThreadId(payload) : null;
  const stateHookEvent =
    source === "codex" || source === "trae"
      ? toAgentHookStateEvent(normalizedEvent)
      : null;
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
