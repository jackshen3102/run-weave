import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installAllHooks } from "../electron/src/hooks/hook-installer.ts";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const resourcesDir = path.join(repoRoot, "electron", "resources");
const toolkitDir = path.join(repoRoot, "plugins", "toolkit");
const toolkitHooksDir = path.join(repoRoot, "plugins", "toolkit", "hooks");
const toolkitHooksConfigPath = path.join(toolkitDir, "hooks.json");
const electronHooksDir = path.join(resourcesDir, "hooks");
const hookAssets = [
  "runweave-hook-bridge.cjs",
  "runweave-hook-dispatch.cjs",
  "feishu_stop_notify.sh",
];
const toolkitHookEvents = [
  "PostToolUse",
  "SessionStart",
  "Stop",
  "SubagentStop",
  "UserPromptSubmit",
];
const toolkitHookCommand =
  'node "${CLAUDE_PLUGIN_ROOT:-__PLUGIN_DIR__}/hooks/runweave-hook-dispatch.cjs"';

const toolkitHooksConfig = JSON.parse(
  await readFile(toolkitHooksConfigPath, "utf8"),
);
for (const event of toolkitHookEvents) {
  const command = getToolkitHookCommand(toolkitHooksConfig, event);
  assert.equal(
    command,
    toolkitHookCommand,
    `${event} must point at the toolkit hook dispatcher`,
  );
}

for (const asset of hookAssets) {
  const toolkitAsset = await readFile(
    path.join(toolkitHooksDir, asset),
    "utf8",
  );
  const electronAsset = await readFile(
    path.join(electronHooksDir, asset),
    "utf8",
  );
  assert.equal(
    electronAsset,
    toolkitAsset,
    `${asset} must stay synchronized between toolkit source and Electron resources`,
  );
}

const homeDir = await mkdtemp(path.join(os.tmpdir(), "runweave-hook-home-"));
try {
  await mkdir(path.join(homeDir, ".codex"), { recursive: true });
  await mkdir(path.join(homeDir, ".trae"), { recursive: true });

  await writeFile(
    path.join(homeDir, ".codex", "hooks.json"),
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: "/third-party/hook --keep",
                  timeout: 9,
                },
              ],
            },
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `${homeDir}/.browser-viewer/bin/browser-viewer-hook-bridge --source codex`,
                  timeout: 5,
                },
              ],
            },
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `${homeDir}/.codex/notify.sh`,
                  timeout: 5,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  );

  await writeFile(
    path.join(homeDir, ".trae", "traecli.toml"),
    [
      'model = "test"',
      "",
      "# >>> runweave-hooks (managed by Runweave) >>>",
      "[[hooks.Stop]]",
      "",
      "[[hooks.Stop.hooks]]",
      "command = '/old/.runweave/bin/runweave-hook-bridge --source trae'",
      'timeout = "unlimited"',
      'type = "command"',
      "",
      "# <<< runweave-hooks (managed by Runweave) <<<",
      "",
      "# >>> runweave-hooks (managed by Browser Viewer) >>>",
      "[[hooks.Stop]]",
      "",
      "[[hooks.Stop.hooks]]",
      `command = '${homeDir}/.browser-viewer/bin/browser-viewer-hook-bridge --source trae'`,
      'timeout = "unlimited"',
      'type = "command"',
      "",
      "# <<< runweave-hooks (managed by Browser Viewer) <<<",
      "",
      "# >>> runweave-hooks (managed by Browser Viewer) >>>",
      "",
    ].join("\n"),
  );

  await installAllHooks({ homeDir, resourcesDir });

  const launcherPath = path.join(
    homeDir,
    ".runweave",
    "bin",
    "runweave-hook-bridge",
  );
  const installedLauncher = await readFile(launcherPath, "utf8");
  const resourceLauncher = await readFile(
    path.join(electronHooksDir, "runweave-hook-bridge.cjs"),
    "utf8",
  );
  assert.equal(installedLauncher, resourceLauncher);
  await chmod(launcherPath, 0o755);

  const codexHooks = JSON.parse(
    await readFile(path.join(homeDir, ".codex", "hooks.json"), "utf8"),
  );
  assert.equal(
    findRunweaveHooks(Object.values(codexHooks.hooks).flat()).length,
    0,
    "Codex global hooks must not contain Runweave hooks after plugin migration",
  );
  assert.deepEqual(codexHooks.hooks.Stop[0].hooks[0], {
    type: "command",
    command: "/third-party/hook --keep",
    timeout: 9,
  });
  assert.equal(
    JSON.stringify(codexHooks).includes("browser-viewer-hook-bridge"),
    false,
  );
  assert.equal(JSON.stringify(codexHooks).includes(".codex/notify.sh"), false);

  const traeToml = await readFile(
    path.join(homeDir, ".trae", "traecli.toml"),
    "utf8",
  );
  assert.equal(traeToml.includes('model = "test"'), true);
  assert.equal(traeToml.includes("managed by Runweave"), false);
  assert.equal(traeToml.includes("managed by Browser Viewer"), false);
  assert.equal(traeToml.includes("browser-viewer-hook-bridge"), false);
  assert.equal(traeToml.includes("runweave-hook-bridge --source trae"), false);
  assert.equal(
    traeToml.includes("/old/.runweave/bin/runweave-hook-bridge"),
    false,
  );
  for (const event of [
    "PostToolUse",
    "Stop",
    "SubagentStop",
    "UserPromptSubmit",
  ]) {
    assert.equal(
      traeToml.includes(`[[hooks.${event}]]`),
      false,
      `Trae global TOML must not install ${event} after plugin migration`,
    );
  }

  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        token: request.headers["x-runweave-hook-token"],
        body: body ? JSON.parse(body) : null,
      });
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const endpoint = `http://127.0.0.1:${port}/internal/terminal/agent-hook`;
    await runLauncher(launcherPath, {
      HOME: homeDir,
      RUNWEAVE_HOOK_ENDPOINT: endpoint,
      RUNWEAVE_COMPLETION_HOOK_ENDPOINT: `http://127.0.0.1:${port}/internal/terminal-completion`,
      RUNWEAVE_HOOK_TOKEN: "token-1",
      RUNWEAVE_TERMINAL_SESSION_ID: "terminal-1",
      RUNWEAVE_PROJECT_ID: "project-1",
      RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "/internal/terminal/agent-hook");
    assert.equal(requests[0].token, "token-1");
    assert.deepEqual(requests[0].body, {
      terminalSessionId: "terminal-1",
      projectId: "project-1",
      threadId: "thread-1",
      agent: "codex",
      hookEvent: "Stop",
    });
    assert.equal(requests[1].url, "/internal/terminal-completion");
    assert.equal(requests[1].token, "token-1");
    assert.equal(requests[1].body.terminalSessionId, "terminal-1");
    assert.equal(requests[1].body.source, "codex");
    assert.equal(requests[1].body.rawHookEvent, "Stop");
    assert.equal(requests[1].body.summary, "done");

    await runToolkitHookCommand(
      getToolkitHookCommand(toolkitHooksConfig, "Stop"),
      "codex",
      {
        HOME: homeDir,
        CLAUDE_PLUGIN_ROOT: toolkitDir,
        RUNWEAVE_HOOK_ENDPOINT: endpoint,
        RUNWEAVE_COMPLETION_HOOK_ENDPOINT: `http://127.0.0.1:${port}/internal/terminal-completion`,
        RUNWEAVE_HOOK_TOKEN: "token-2",
        RUNWEAVE_TERMINAL_SESSION_ID: "terminal-2",
        RUNWEAVE_PROJECT_ID: "project-2",
        RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
      },
    );

    assert.equal(requests.length, 4);
    assert.equal(requests[2].url, "/internal/terminal/agent-hook");
    assert.equal(requests[2].token, "token-2");
    assert.deepEqual(requests[2].body, {
      terminalSessionId: "terminal-2",
      projectId: "project-2",
      threadId: "thread-1",
      agent: "codex",
      hookEvent: "Stop",
    });
    assert.equal(requests[3].url, "/internal/terminal-completion");
    assert.equal(requests[3].token, "token-2");
    assert.equal(requests[3].body.terminalSessionId, "terminal-2");
    assert.equal(requests[3].body.source, "codex");
    assert.equal(requests[3].body.rawHookEvent, "Stop");
    assert.equal(requests[3].body.summary, "done");

    await runToolkitHookCommand(
      getToolkitHookCommand(toolkitHooksConfig, "Stop"),
      "trae",
      {
        HOME: homeDir,
        RUNWEAVE_HOOK_ENDPOINT: endpoint,
        RUNWEAVE_COMPLETION_HOOK_ENDPOINT: `http://127.0.0.1:${port}/internal/terminal-completion`,
        RUNWEAVE_HOOK_TOKEN: "token-3",
        RUNWEAVE_TERMINAL_SESSION_ID: "terminal-3",
        RUNWEAVE_PROJECT_ID: "project-3",
        RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
      },
    );

    assert.equal(requests.length, 6);
    assert.equal(requests[4].url, "/internal/terminal/agent-hook");
    assert.equal(requests[4].token, "token-3");
    assert.deepEqual(requests[4].body, {
      terminalSessionId: "terminal-3",
      projectId: "project-3",
      agent: "trae",
      hookEvent: "Stop",
    });
    assert.equal(requests[5].url, "/internal/terminal-completion");
    assert.equal(requests[5].token, "token-3");
    assert.equal(requests[5].body.terminalSessionId, "terminal-3");
    assert.equal(requests[5].body.source, "trae");
    assert.equal(requests[5].body.rawHookEvent, "Stop");
    assert.equal(requests[5].body.summary, "done");

    await runLauncher(launcherPath, {
      HOME: homeDir,
      RUNWEAVE_HOOK_ENDPOINT: endpoint,
      RUNWEAVE_COMPLETION_HOOK_ENDPOINT: `http://127.0.0.1:${port}/internal/terminal-completion`,
      RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      requests.length,
      6,
      "launcher without Runweave identity must not post any request",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
} finally {
  await rm(homeDir, { force: true, recursive: true });
}

console.log("toolkit hook verification passed");

function findRunweaveHooks(entries) {
  return (Array.isArray(entries) ? entries : [])
    .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []))
    .filter((hook) => hook?._runweaveManaged === true);
}

function getToolkitHookCommand(config, event) {
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

function runLauncher(launcherPath, extraEnv) {
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

    const child = spawn(process.execPath, [launcherPath, "--source", "codex"], {
      env: {
        ...env,
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

function runToolkitHookCommand(command, source, extraEnv) {
  const payload = JSON.stringify({
    hook_event_name: "Stop",
    cwd: "/tmp/runweave-hook-test",
    summary: "done",
    session_id: "thread-1",
  });
  const runnableCommand = command.replaceAll("__PLUGIN_DIR__", toolkitDir);

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("RUNWEAVE_")) {
        delete env[key];
      }
    }

    const child = spawn("bash", ["-lc", runnableCommand], {
      cwd: toolkitDir,
      env: {
        ...env,
        ...extraEnv,
        RUNWEAVE_HOOK_SOURCE: source,
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
