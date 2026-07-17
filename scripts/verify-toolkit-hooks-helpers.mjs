import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const toolkitDir = path.join(repoRoot, "plugins", "toolkit");

export function findRunweaveHooks(entries) {
  return (Array.isArray(entries) ? entries : [])
    .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []))
    .filter((hook) => hook?._runweaveManaged === true);
}

export function getToolkitHookCommand(config, event) {
  const entries = config?.hooks?.[event];
  assert.equal(Array.isArray(entries), true, `${event} hooks must be an array`);

  const commands = entries.flatMap((entry) =>
    Array.isArray(entry?.hooks)
      ? entry.hooks
          .map((hook) => hook?.command)
          .filter((command) => typeof command === "string")
      : [],
  );
  assert.equal(commands.length, 1, `${event} must define one command hook`);
  return commands[0];
}

export function verifyToolkitHookCommands(config, events, expectedCommand) {
  for (const event of events) {
    assert.equal(
      getToolkitHookCommand(config, event),
      expectedCommand,
      `${event} must point at the toolkit hook dispatcher`,
    );
  }
}

export function runLauncher(launcherPath, extraEnv) {
  const payload = JSON.stringify({
    hook_event_name: "Stop",
    cwd: "/tmp/runweave-hook-test",
    summary: "done",
    session_id: "thread-1",
  });

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("RUNWEAVE_")) {
        delete env[key];
      }
    }
    delete env.TMUX;

    const child = spawn(process.execPath, [launcherPath, "--source", "codex"], {
      env: {
        ...env,
        TMUX_PANE: "%13",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`launcher exited with ${code}: ${stderr}`));
    });
    child.stdin.end(payload);
  });
}

export async function assertFileMissing(filePath, message) {
  try {
    await readFile(filePath, "utf8");
  } catch {
    return;
  }
  assert.fail(message);
}

export function runToolkitHookCommand(
  command,
  source,
  extraEnv,
  payloadOverrides = {},
  options = {},
) {
  const payload = JSON.stringify({
    hook_event_name: "Stop",
    cwd: "/tmp/runweave-hook-test",
    summary: "done",
    session_id: "thread-1",
    ...payloadOverrides,
  });
  const runnableCommand =
    options.replacePluginDirPlaceholder === false
      ? command
      : command.replaceAll(
          "__PLUGIN_DIR__",
          options.pluginDirPlaceholder ?? toolkitDir,
        );

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("RUNWEAVE_")) {
        delete env[key];
      }
    }
    delete env.TMUX;
    delete env.TMUX_PANE;

    const child = spawn("bash", ["-lc", runnableCommand], {
      cwd: toolkitDir,
      env: {
        ...env,
        ...(options.omitTmuxPane ? {} : { TMUX_PANE: "%13" }),
        ...extraEnv,
        ...(options.setHookSource === false
          ? {}
          : { RUNWEAVE_HOOK_SOURCE: source }),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`toolkit hook exited with ${code}: ${stderr}`));
    });
    child.stdin.end(payload);
  });
}

export async function verifyTmuxPaneContextFailure(params) {
  const requestsBeforeFailure = params.requests.length;
  const appServerRequestsBeforeFailure = params.appServerRequests.length;
  await runToolkitHookCommand(params.command, "trae", {
    HOME: params.homeDir,
    RUNWEAVE_TOOLKIT_PLUGIN_ROOT: toolkitDir,
    RUNWEAVE_APP_SERVER_URL: params.appServerUrl,
    RUNWEAVE_APP_SERVER_TOKEN: "app-server-token",
    RUNWEAVE_HOOK_ENDPOINT: params.endpoint,
    RUNWEAVE_COMPLETION_HOOK_ENDPOINT: params.completionEndpoint,
    RUNWEAVE_HOOK_TOKEN: "token-tmux-failure",
    RUNWEAVE_TERMINAL_SESSION_ID: "terminal-tmux-failure",
    RUNWEAVE_TERMINAL_PANEL_ID: "stale-panel",
    RUNWEAVE_PROJECT_ID: "project-tmux-failure",
    RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
    RUNWEAVE_VERIFY_TMUX_FAIL: "1",
    TMUX: "/tmp/runweave-verify.sock,1,0",
    TMUX_BINARY: params.fakeTmuxPath,
  });

  const appServerHook =
    params.appServerRequests[appServerRequestsBeforeFailure];
  assert.equal(appServerHook.kind, "agent.hook");
  assert.equal(appServerHook.payload.panelId, null);
  assert.equal(appServerHook.scope.terminalPanelId, null);
  assert.equal(appServerHook.payload.tmuxPaneId, "%13");
  const backendHook = params.requests[requestsBeforeFailure];
  assert.equal(backendHook.url, "/internal/terminal/agent-hook");
  assert.equal(backendHook.body.panelId, undefined);
  assert.equal(backendHook.body.tmuxPaneId, "%13");
}

export async function writeAppServerDiscoveryFiles(stateDir, port, token) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "app-server.lock.json"),
    `${JSON.stringify({
      pid: process.pid,
      host: "127.0.0.1",
      port,
      startedAt: new Date().toISOString(),
      version: "0.1.0",
    })}\n`,
  );
  await writeFile(path.join(stateDir, "app-server-token"), `${token}\n`);
}

export async function verifyPtyProviderInference(params) {
  const requestStart = params.requests.length;
  const appServerRequestStart = params.appServerRequests.length;
  const baseEnv = {
    HOME: params.homeDir,
    RUNWEAVE_TOOLKIT_PLUGIN_ROOT: toolkitDir,
    RUNWEAVE_APP_SERVER_URL: params.appServerUrl,
    RUNWEAVE_APP_SERVER_TOKEN: "app-server-token",
    RUNWEAVE_HOOK_ENDPOINT: params.endpoint,
    RUNWEAVE_COMPLETION_HOOK_ENDPOINT: params.completionEndpoint,
    RUNWEAVE_PROJECT_ID: "project-pty-provider",
    RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
  };
  const ptyOptions = {
    omitTmuxPane: true,
    replacePluginDirPlaceholder: false,
    setHookSource: false,
  };
  const codexRoot = path.join(params.homeDir, ".codex", "plugins", "toolkit");
  const traeRoot = path.join(
    params.homeDir,
    ".trae",
    ".tmp",
    "marketplaces",
    "local",
    "plugins",
    "toolkit",
  );
  const claudeRoot = path.join(params.homeDir, ".claude", "plugins", "toolkit");

  await runToolkitHookCommand(
    params.userPromptCommand,
    "codex",
    {
      ...baseEnv,
      CODEX_PLUGIN_ROOT: codexRoot,
      RUNWEAVE_HOOK_TOKEN: "token-pty-codex-query",
      RUNWEAVE_TERMINAL_SESSION_ID: "terminal-pty-codex-query",
    },
    {
      hook_event_name: "UserPromptSubmit",
      prompt: "safe codex query",
      session_id: "thread-pty-codex",
    },
    ptyOptions,
  );
  assert.equal(params.appServerRequests.at(-1).payload.source, "codex");
  assert.equal(
    params.appServerRequests.at(-1).payload.stateHookEvent,
    "UserPromptSubmit",
  );
  assert.equal(params.requests.at(-1).body.agent, "codex");
  assert.equal(params.requests.at(-1).body.query, "safe codex query");
  assert.equal(params.requests.at(-1).body.tmuxPaneId, undefined);

  await runToolkitHookCommand(
    params.userPromptCommand,
    "trae",
    {
      ...baseEnv,
      CLAUDE_PLUGIN_ROOT: traeRoot,
      RUNWEAVE_HOOK_TOKEN: "token-pty-trae-query",
      RUNWEAVE_TERMINAL_SESSION_ID: "terminal-pty-trae-query",
    },
    {
      hook_event_name: "UserPromptSubmit",
      prompt: "safe trae query",
      session_id: "thread-pty-trae",
    },
    ptyOptions,
  );
  assert.equal(params.appServerRequests.at(-1).payload.source, "trae");
  assert.equal(
    params.appServerRequests.at(-1).payload.stateHookEvent,
    "UserPromptSubmit",
  );
  assert.equal(params.requests.at(-1).body.agent, "trae");
  assert.equal(params.requests.at(-1).body.query, "safe trae query");
  assert.equal(params.requests.at(-1).body.tmuxPaneId, undefined);

  await runToolkitHookCommand(
    params.stopCommand,
    "trae",
    {
      ...baseEnv,
      CLAUDE_PLUGIN_ROOT: traeRoot,
      RUNWEAVE_HOOK_TOKEN: "token-pty-trae-response",
      RUNWEAVE_TERMINAL_SESSION_ID: "terminal-pty-trae-response",
    },
    {},
    ptyOptions,
  );
  assert.equal(params.appServerRequests.at(-2).payload.source, "trae");
  assert.equal(params.appServerRequests.at(-2).payload.stateHookEvent, "Stop");
  assert.equal(params.requests.at(-2).body.agent, "trae");
  assert.equal(params.requests.at(-2).body.response, "done");
  assert.equal(params.requests.at(-2).body.tmuxPaneId, undefined);

  const requestsBeforeClaude = params.requests.length;
  await runToolkitHookCommand(
    params.userPromptCommand,
    "claude",
    {
      ...baseEnv,
      CLAUDE_PLUGIN_ROOT: claudeRoot,
      RUNWEAVE_HOOK_TOKEN: "token-pty-claude",
      RUNWEAVE_TERMINAL_SESSION_ID: "terminal-pty-claude",
    },
    { hook_event_name: "UserPromptSubmit", session_id: "thread-pty-claude" },
    ptyOptions,
  );
  assert.equal(params.appServerRequests.at(-1).payload.source, "claude");
  assert.equal(params.requests.length, requestsBeforeClaude);

  const requestsBeforeConflict = params.requests.length;
  await runToolkitHookCommand(
    params.userPromptCommand,
    "codex",
    {
      ...baseEnv,
      CODEX_PLUGIN_ROOT: codexRoot,
      CLAUDE_PLUGIN_ROOT: traeRoot,
      RUNWEAVE_HOOK_TOKEN: "token-pty-conflict",
      RUNWEAVE_TERMINAL_SESSION_ID: "terminal-pty-conflict",
    },
    { hook_event_name: "UserPromptSubmit", session_id: "thread-pty-conflict" },
    ptyOptions,
  );
  assert.equal(params.appServerRequests.at(-1).payload.source, "unknown");
  assert.equal(params.requests.length, requestsBeforeConflict);

  await runToolkitHookCommand(
    params.userPromptCommand,
    "codex",
    {
      ...baseEnv,
      CODEX_PLUGIN_ROOT: codexRoot,
      CLAUDE_PLUGIN_ROOT: traeRoot,
      RUNWEAVE_HOOK_TOKEN: "token-pty-explicit",
      RUNWEAVE_TERMINAL_SESSION_ID: "terminal-pty-explicit",
    },
    {
      hook_event_name: "UserPromptSubmit",
      prompt: "safe explicit query",
      session_id: "thread-pty-explicit",
    },
    { ...ptyOptions, setHookSource: true },
  );
  assert.equal(params.appServerRequests.at(-1).payload.source, "codex");
  assert.equal(params.requests.at(-1).body.agent, "codex");
  assert.equal(params.requests.at(-1).body.query, "safe explicit query");
  assert.equal(params.requests.length - requestStart, 5);
  assert.equal(params.appServerRequests.length - appServerRequestStart, 7);
}

export async function verifyPreToolHook(params) {
  await runToolkitHookCommand(
    params.command,
    "codex",
    {
      HOME: params.homeDir,
      RUNWEAVE_TOOLKIT_PLUGIN_ROOT: toolkitDir,
      RUNWEAVE_APP_SERVER_URL: params.appServerUrl,
      RUNWEAVE_APP_SERVER_TOKEN: "app-server-token",
      RUNWEAVE_HOOK_ENDPOINT: params.endpoint,
      RUNWEAVE_HOOK_TOKEN: "token-5",
      RUNWEAVE_TERMINAL_SESSION_ID: "terminal-5",
      RUNWEAVE_PROJECT_ID: "project-5",
      RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
    },
    {
      hook_event_name: "PreToolUse",
      session_id: "thread-5",
      tool_use_id: "tool-call-5",
      tool_name: "shell",
      tool_input: { command: "pwd" },
    },
    { replacePluginDirPlaceholder: false },
  );
  assert.equal(params.requests.length, 12);
  assert.equal(params.appServerRequests.length, 10);
  assert.equal(params.requests[11].url, "/internal/terminal/agent-hook");
  assert.match(params.requests[11].body.activityEventId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(
    { ...params.requests[11].body, activityEventId: undefined },
    {
      activityEventId: undefined,
      terminalSessionId: "terminal-5",
      projectId: "project-5",
      tmuxPaneId: "%13",
      threadId: "thread-5",
      commandName: null,
      rawHookEvent: "PreToolUse",
      toolUseId: "tool-call-5",
      toolName: "shell",
      toolInput: { command: "pwd" },
      agent: "codex",
      hookEvent: "ToolRequested",
    },
  );
}
