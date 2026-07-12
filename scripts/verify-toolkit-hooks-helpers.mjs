import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
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

    const child = spawn("bash", ["-lc", runnableCommand], {
      cwd: toolkitDir,
      env: {
        ...env,
        TMUX_PANE: "%13",
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
  assert.deepEqual({ ...params.requests[11].body, activityEventId: undefined }, {
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
  });
}
