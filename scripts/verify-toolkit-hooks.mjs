import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  chmod,
  copyFile,
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
import {
  assertFileMissing,
  findRunweaveHooks,
  getToolkitHookCommand,
  runLauncher,
  runToolkitHookCommand,
  verifyPtyProviderInference,
  verifyPreToolHook,
  verifyToolkitHookCommands,
} from "./verify-toolkit-hooks-helpers.mjs";
import { processTerminalAgentHook } from "../backend/src/terminal/agent-hook-processor.ts";
import {
  buildAgentResumeCommand,
  resolveAgentThreadToResume,
} from "../backend/src/terminal/runtime-launcher.ts";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const resourcesDir = path.join(repoRoot, "electron", "resources");
const toolkitDir = path.join(repoRoot, "plugins", "toolkit");
const toolkitHooksDir = path.join(repoRoot, "plugins", "toolkit", "hooks");
const toolkitHooksConfigPath = path.join(toolkitDir, "hooks.json");
const electronHooksDir = path.join(resourcesDir, "hooks");
const hookAssets = [
  "app-server-client.cjs",
  "runweave-hook-bridge.cjs",
  "runweave-hook-dispatch.cjs",
  "runweave-hook-payload.cjs",
  "feishu_stop_notify.sh",
];
const toolkitHookEvents = [
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "Stop",
  "SubagentStop",
  "UserPromptSubmit",
];
const toolkitHookCommand =
  'sh -c \'for root in "${RUNWEAVE_TOOLKIT_PLUGIN_ROOT:-}" "__PLUGIN_DIR__" . "${CODEX_PLUGIN_ROOT:-}" "$HOME/.codex/plugins/cache/runweave/toolkit/latest" "$HOME/.codex/plugins/cache/runweave/toolkit"/* "${CLAUDE_PLUGIN_ROOT:-}"; do if [ -n "$root" ] && [ -f "$root/hooks/runweave-hook-dispatch.cjs" ]; then exec node "$root/hooks/runweave-hook-dispatch.cjs"; fi; done; exit 0\'';

const toolkitHooksConfig = JSON.parse(
  await readFile(toolkitHooksConfigPath, "utf8"),
);
verifyToolkitHookCommands(toolkitHooksConfig, toolkitHookEvents, toolkitHookCommand);

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
  const fakeTmuxPath = path.join(homeDir, "tmux");
  await writeFile(
    fakeTmuxPath,
    [
      "#!/bin/sh",
      "printf '%s\\n' \"${RUNWEAVE_VERIFY_PANE_COMMAND:-traex}__RUNWEAVE_METADATA_FIELD__node__RUNWEAVE_METADATA_FIELD__panel-pane-3\"",
      "",
    ].join("\n"),
  );
  await chmod(fakeTmuxPath, 0o755);
  const codexToolkitDir = path.join(
    homeDir,
    ".codex",
    "plugins",
    "cache",
    "runweave",
    "toolkit",
    "current",
  );
  const traeToolkitDir = path.join(
    homeDir,
    ".trae",
    ".tmp",
    "marketplaces",
    "local",
    "plugins",
    "toolkit",
  );
  await mkdir(path.join(codexToolkitDir, "hooks"), { recursive: true });
  for (const asset of hookAssets) {
    await copyFile(
      path.join(toolkitHooksDir, asset),
      path.join(codexToolkitDir, "hooks", asset),
    );
  }

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
  const installedAppServerClient = await readFile(
    path.join(homeDir, ".runweave", "bin", "app-server-client.cjs"),
    "utf8",
  );
  const resourceAppServerClient = await readFile(
    path.join(electronHooksDir, "app-server-client.cjs"),
    "utf8",
  );
  assert.equal(installedAppServerClient, resourceAppServerClient);
  const installedHookPayload = await readFile(
    path.join(homeDir, ".runweave", "bin", "runweave-hook-payload.cjs"),
    "utf8",
  );
  const resourceHookPayload = await readFile(
    path.join(electronHooksDir, "runweave-hook-payload.cjs"),
    "utf8",
  );
  assert.equal(installedHookPayload, resourceHookPayload);
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
  const appServerRequests = [];
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
  const appServer = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            service: "runweave-app-server",
            protocolVersion: 1,
            pid: process.pid,
            version: "0.1.0",
          }),
        );
        return;
      }
      if (request.url === "/events") {
        const authorized =
          request.headers.authorization === "Bearer app-server-token";
        if (!authorized) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ message: "Unauthorized" }));
          return;
        }
        const parsed = body ? JSON.parse(body) : null;
        appServerRequests.push(parsed);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            event: {
              id: String(appServerRequests.length),
              version: 1,
              createdAt: new Date().toISOString(),
              ...parsed,
            },
          }),
        );
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Not found" }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const appServerPort = appServer.address().port;
    const endpoint = `http://127.0.0.1:${port}/internal/terminal/agent-hook`;
    await runLauncher(launcherPath, {
      HOME: homeDir,
      RUNWEAVE_HOOK_ENDPOINT: endpoint,
      RUNWEAVE_COMPLETION_HOOK_ENDPOINT: `http://127.0.0.1:${port}/internal/terminal-completion`,
      RUNWEAVE_HOOK_TOKEN: "token-no-app-server",
      RUNWEAVE_TERMINAL_SESSION_ID: "terminal-no-app-server",
      RUNWEAVE_PROJECT_ID: "project-no-app-server",
      RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
    });
    assert.equal(requests.length, 2);
    assert.equal(appServerRequests.length, 0);
    await assertFileMissing(
      path.join(homeDir, ".runweave", "app-server", "app-server.lock.json"),
      "hook bridge must not start app-server or create an app-server lock",
    );
    requests.length = 0;

    await runLauncher(launcherPath, {
      HOME: homeDir,
      RUNWEAVE_APP_SERVER_URL: `http://127.0.0.1:${appServerPort}`,
      RUNWEAVE_APP_SERVER_TOKEN: "app-server-token",
      RUNWEAVE_HOOK_ENDPOINT: endpoint,
      RUNWEAVE_COMPLETION_HOOK_ENDPOINT: `http://127.0.0.1:${port}/internal/terminal-completion`,
      RUNWEAVE_HOOK_TOKEN: "token-1",
      RUNWEAVE_TERMINAL_SESSION_ID: "terminal-1",
      RUNWEAVE_PROJECT_ID: "project-1",
      RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
    });

    assert.equal(requests.length, 2);
    assert.equal(appServerRequests.length, 2);
    assert.equal(appServerRequests[0].kind, "agent.hook");
    assert.equal(appServerRequests[0].source.app, "hook");
    assert.equal(appServerRequests[0].scope.terminalSessionId, "terminal-1");
    assert.equal(appServerRequests[0].payload.source, "codex");
    assert.equal(appServerRequests[1].kind, "agent.completion");
    assert.equal(appServerRequests[1].payload.source, "codex");
    assert.equal(appServerRequests[1].payload.summary, "done");
    assert.equal(requests[0].url, "/internal/terminal/agent-hook");
    assert.equal(requests[0].token, "token-1");
    assert.deepEqual(requests[0].body, { activityEventId: requests[0].body.activityEventId,
      terminalSessionId: "terminal-1",
      projectId: "project-1",
      tmuxPaneId: "%13",
      threadId: "thread-1",
      rawHookEvent: "Stop",
      response: "done",
      agent: "codex",
      hookEvent: "Stop",
      commandName: null,
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
        RUNWEAVE_APP_SERVER_URL: `http://127.0.0.1:${appServerPort}`,
        RUNWEAVE_APP_SERVER_TOKEN: "app-server-token",
        RUNWEAVE_HOOK_ENDPOINT: endpoint,
        RUNWEAVE_COMPLETION_HOOK_ENDPOINT: `http://127.0.0.1:${port}/internal/terminal-completion`,
        RUNWEAVE_HOOK_TOKEN: "token-2",
        RUNWEAVE_TERMINAL_SESSION_ID: "terminal-2",
        RUNWEAVE_PROJECT_ID: "project-2",
        RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
      },
    );

    assert.equal(requests.length, 4);
    assert.equal(appServerRequests.length, 4);
    assert.equal(appServerRequests[2].kind, "agent.hook");
    assert.equal(appServerRequests[2].payload.source, "codex");
    assert.equal(appServerRequests[3].kind, "agent.completion");
    assert.equal(appServerRequests[3].payload.source, "codex");
    assert.equal(requests[2].url, "/internal/terminal/agent-hook");
    assert.equal(requests[2].token, "token-2");
    assert.deepEqual(requests[2].body, { activityEventId: requests[2].body.activityEventId,
      terminalSessionId: "terminal-2",
      projectId: "project-2",
      tmuxPaneId: "%13",
      threadId: "thread-1",
      rawHookEvent: "Stop",
      response: "done",
      agent: "codex",
      hookEvent: "Stop",
      commandName: null,
    });
    assert.equal(requests[3].url, "/internal/terminal-completion");
    assert.equal(requests[3].token, "token-2");
    assert.equal(requests[3].body.terminalSessionId, "terminal-2");
    assert.equal(requests[3].body.source, "codex");
    assert.equal(requests[3].body.rawHookEvent, "Stop");
    assert.equal(requests[3].body.summary, "done");

    await runToolkitHookCommand(
      getToolkitHookCommand(toolkitHooksConfig, "UserPromptSubmit"),
      "codex",
      {
        HOME: homeDir,
        RUNWEAVE_TOOLKIT_PLUGIN_ROOT: toolkitDir,
        RUNWEAVE_APP_SERVER_URL: `http://127.0.0.1:${appServerPort}`,
        RUNWEAVE_APP_SERVER_TOKEN: "app-server-token",
        RUNWEAVE_HOOK_ENDPOINT: endpoint,
        RUNWEAVE_COMPLETION_HOOK_ENDPOINT: `http://127.0.0.1:${port}/internal/terminal-completion`,
        RUNWEAVE_HOOK_TOKEN: "token-2b",
        RUNWEAVE_TERMINAL_SESSION_ID: "terminal-2b",
        RUNWEAVE_PROJECT_ID: "project-2b",
        RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
      },
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "thread-2b",
      },
      { replacePluginDirPlaceholder: false },
    );

    assert.equal(requests.length, 5);
    assert.equal(appServerRequests.length, 5);
    assert.equal(appServerRequests[4].kind, "agent.hook");
    assert.equal(appServerRequests[4].payload.source, "codex");
    assert.equal(appServerRequests[4].payload.rawHookEvent, "UserPromptSubmit");
    assert.equal(
      appServerRequests[4].payload.stateHookEvent,
      "UserPromptSubmit",
    );
    assert.equal(appServerRequests[4].correlationId, "thread-2b");
    assert.equal(requests[4].url, "/internal/terminal/agent-hook");
    assert.equal(requests[4].token, "token-2b");
    assert.deepEqual(requests[4].body, { activityEventId: requests[4].body.activityEventId,
      terminalSessionId: "terminal-2b",
      projectId: "project-2b",
      tmuxPaneId: "%13",
      threadId: "thread-2b",
      rawHookEvent: "UserPromptSubmit",
      agent: "codex",
      hookEvent: "UserPromptSubmit",
      commandName: null,
    });

    await runToolkitHookCommand(
      getToolkitHookCommand(toolkitHooksConfig, "Stop"),
      "codex",
      {
        HOME: homeDir,
        CLAUDE_PLUGIN_ROOT: toolkitDir,
        RUNWEAVE_APP_SERVER_URL: `http://127.0.0.1:${appServerPort}`,
        RUNWEAVE_APP_SERVER_TOKEN: "app-server-token",
        RUNWEAVE_HOOK_ENDPOINT: endpoint,
        RUNWEAVE_COMPLETION_HOOK_ENDPOINT: `http://127.0.0.1:${port}/internal/terminal-completion`,
        RUNWEAVE_HOOK_TOKEN: "token-2c",
        RUNWEAVE_TERMINAL_SESSION_ID: "terminal-2c",
        RUNWEAVE_PROJECT_ID: "project-2c",
        RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
      },
      {},
      {
        pluginDirPlaceholder: codexToolkitDir,
        setHookSource: false,
      },
    );

    assert.equal(requests.length, 7);
    assert.equal(appServerRequests.length, 7);
    assert.equal(appServerRequests[5].kind, "agent.hook");
    assert.equal(appServerRequests[5].payload.source, "codex");
    assert.equal(appServerRequests[6].kind, "agent.completion");
    assert.equal(appServerRequests[6].payload.source, "codex");
    assert.equal(requests[5].url, "/internal/terminal/agent-hook");
    assert.equal(requests[5].token, "token-2c");
    assert.equal(requests[5].body.agent, "codex");
    assert.equal(requests[6].url, "/internal/terminal-completion");
    assert.equal(requests[6].token, "token-2c");
    assert.equal(requests[6].body.terminalSessionId, "terminal-2c");
    assert.equal(requests[6].body.source, "codex");

    await runToolkitHookCommand(
      getToolkitHookCommand(toolkitHooksConfig, "Stop"),
      "trae",
      {
        HOME: homeDir,
        RUNWEAVE_APP_SERVER_URL: `http://127.0.0.1:${appServerPort}`,
        RUNWEAVE_APP_SERVER_TOKEN: "app-server-token",
        RUNWEAVE_HOOK_ENDPOINT: endpoint,
        RUNWEAVE_COMPLETION_HOOK_ENDPOINT: `http://127.0.0.1:${port}/internal/terminal-completion`,
        RUNWEAVE_HOOK_TOKEN: "token-3",
        RUNWEAVE_TERMINAL_SESSION_ID: "terminal-3",
        RUNWEAVE_TERMINAL_PANEL_ID: "stale-panel",
        RUNWEAVE_TOOLKIT_PLUGIN_ROOT: toolkitDir,
        CLAUDE_PLUGIN_ROOT: traeToolkitDir,
        RUNWEAVE_PROJECT_ID: "project-3",
        RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
        TMUX: "/tmp/runweave-verify.sock,1,0",
        TMUX_BINARY: fakeTmuxPath,
      },
      {},
      {
        pluginDirPlaceholder: traeToolkitDir,
        setHookSource: false,
      },
    );

    assert.equal(requests.length, 9);
    assert.equal(appServerRequests.length, 9);
    assert.equal(appServerRequests[7].kind, "agent.hook");
    assert.equal(appServerRequests[7].payload.source, "trae");
    assert.equal(appServerRequests[7].payload.threadId, "thread-1");
    assert.equal(appServerRequests[7].payload.panelId, "panel-pane-3");
    assert.equal(
      appServerRequests[7].scope.terminalPanelId,
      "panel-pane-3",
    );
    assert.equal(appServerRequests[8].kind, "agent.completion");
    assert.equal(appServerRequests[8].payload.source, "trae");
    assert.equal(requests[7].url, "/internal/terminal/agent-hook");
    assert.equal(requests[7].token, "token-3");
    assert.deepEqual(requests[7].body, { activityEventId: requests[7].body.activityEventId,
      terminalSessionId: "terminal-3",
      projectId: "project-3",
      panelId: "panel-pane-3",
      threadId: "thread-1",
      tmuxPaneId: "%13",
      rawHookEvent: "Stop",
      response: "done",
      agent: "trae",
      hookEvent: "Stop",
      commandName: "traex",
    });
    assert.equal(requests[8].url, "/internal/terminal-completion");
    assert.equal(requests[8].token, "token-3");
    assert.equal(requests[8].body.terminalSessionId, "terminal-3");
    assert.equal(requests[8].body.source, "trae");
    assert.equal(requests[8].body.rawHookEvent, "Stop");
    assert.equal(requests[8].body.summary, "done");
    assert.equal(requests[8].body.panelId, "panel-pane-3");
    assert.equal(requests[8].body.commandName, "traex");

    await runLauncher(launcherPath, {
      HOME: homeDir,
      RUNWEAVE_APP_SERVER_URL: `http://127.0.0.1:${appServerPort}`,
      RUNWEAVE_APP_SERVER_TOKEN: "wrong-token",
      RUNWEAVE_HOOK_ENDPOINT: endpoint,
      RUNWEAVE_COMPLETION_HOOK_ENDPOINT: `http://127.0.0.1:${port}/internal/terminal-completion`,
      RUNWEAVE_HOOK_TOKEN: "token-4",
      RUNWEAVE_TERMINAL_SESSION_ID: "terminal-4",
      RUNWEAVE_PROJECT_ID: "project-4",
      RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
    });

    assert.equal(requests.length, 11);
    assert.equal(
      appServerRequests.length,
      9,
      "app-server 401 must not prevent backend hook fallback",
    );
    assert.equal(requests[9].url, "/internal/terminal/agent-hook");
    assert.equal(requests[10].url, "/internal/terminal-completion");

    await verifyPreToolHook({
      command: getToolkitHookCommand(toolkitHooksConfig, "PreToolUse"),
      homeDir,
      appServerUrl: `http://127.0.0.1:${appServerPort}`,
      endpoint,
      requests,
      appServerRequests,
    });

    await runToolkitHookCommand(
      getToolkitHookCommand(toolkitHooksConfig, "Stop"),
      "claude",
      {
        HOME: homeDir,
        RUNWEAVE_TOOLKIT_PLUGIN_ROOT: toolkitDir,
        RUNWEAVE_APP_SERVER_URL: `http://127.0.0.1:${appServerPort}`,
        RUNWEAVE_APP_SERVER_TOKEN: "app-server-token",
        RUNWEAVE_HOOK_ENDPOINT: endpoint,
        RUNWEAVE_COMPLETION_HOOK_ENDPOINT: `http://127.0.0.1:${port}/internal/terminal-completion`,
        RUNWEAVE_HOOK_TOKEN: "token-claude",
        RUNWEAVE_TERMINAL_SESSION_ID: "terminal-claude",
        RUNWEAVE_TERMINAL_PANEL_ID: "stale-panel",
        RUNWEAVE_PROJECT_ID: "project-claude",
        RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
        RUNWEAVE_VERIFY_PANE_COMMAND: "claude",
        TMUX: "/tmp/runweave-verify.sock,1,0",
        TMUX_BINARY: fakeTmuxPath,
      },
      {},
      {
        pluginDirPlaceholder: path.join(
          homeDir,
          ".claude",
          "plugins",
          "toolkit",
        ),
        setHookSource: false,
      },
    );

    assert.equal(appServerRequests[10].kind, "agent.hook");
    assert.equal(appServerRequests[10].payload.source, "claude");
    assert.equal(appServerRequests[11].kind, "agent.completion");
    assert.equal(appServerRequests[11].payload.source, "claude");
    assert.equal(requests[12].url, "/internal/terminal-completion");
    assert.equal(requests[12].body.source, "claude");
    assert.equal(requests[12].body.commandName, "claude");

    await runToolkitHookCommand(
      getToolkitHookCommand(toolkitHooksConfig, "UserPromptSubmit"),
      "trae",
      {
        HOME: homeDir,
        RUNWEAVE_TOOLKIT_PLUGIN_ROOT: toolkitDir,
        CLAUDE_PLUGIN_ROOT: traeToolkitDir,
        RUNWEAVE_APP_SERVER_URL: `http://127.0.0.1:${appServerPort}`,
        RUNWEAVE_APP_SERVER_TOKEN: "app-server-token",
        RUNWEAVE_HOOK_ENDPOINT: endpoint,
        RUNWEAVE_HOOK_TOKEN: "token-trae-query",
        RUNWEAVE_TERMINAL_SESSION_ID: "terminal-trae-query",
        RUNWEAVE_PROJECT_ID: "project-trae-query",
        RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
        TMUX: "/tmp/runweave-verify.sock,1,0",
        TMUX_BINARY: fakeTmuxPath,
      },
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "safe query",
        session_id: "thread-trae-query",
      },
      { replacePluginDirPlaceholder: false, setHookSource: false },
    );

    assert.equal(appServerRequests[12].kind, "agent.hook");
    assert.equal(appServerRequests[12].payload.source, "trae");
    assert.equal(
      appServerRequests[12].payload.stateHookEvent,
      "UserPromptSubmit",
    );
    assert.equal(requests[13].url, "/internal/terminal/agent-hook");
    assert.equal(requests[13].body.agent, "trae");
    assert.equal(requests[13].body.hookEvent, "UserPromptSubmit");
    assert.equal(requests[13].body.threadId, "thread-trae-query");
    assert.equal(requests[13].body.query, "safe query");

    await verifyPtyProviderInference({
      userPromptCommand: getToolkitHookCommand(
        toolkitHooksConfig,
        "UserPromptSubmit",
      ),
      stopCommand: getToolkitHookCommand(toolkitHooksConfig, "Stop"),
      homeDir,
      appServerUrl: `http://127.0.0.1:${appServerPort}`,
      endpoint,
      completionEndpoint: `http://127.0.0.1:${port}/internal/terminal-completion`,
      requests,
      appServerRequests,
    });

    await runLauncher(launcherPath, {
      HOME: homeDir,
      RUNWEAVE_APP_SERVER_URL: `http://127.0.0.1:${appServerPort}`,
      RUNWEAVE_APP_SERVER_TOKEN: "app-server-token",
      RUNWEAVE_HOOK_ENDPOINT: endpoint,
      RUNWEAVE_COMPLETION_HOOK_ENDPOINT: `http://127.0.0.1:${port}/internal/terminal-completion`,
      RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      requests.length,
      19,
      "launcher without Runweave identity must not post any request",
    );
    assert.equal(
      appServerRequests.length,
      20,
      "launcher without Runweave identity must not post app-server events",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => appServer.close(resolve));
  }
} finally {
  await rm(homeDir, { force: true, recursive: true });
}

await verifyDelayedCrossProviderHookGuard();
await verifyTmuxPaneFallbackUniqueness();
verifyAgentThreadResumeFallback();

console.log("toolkit hook verification passed");

function verifyAgentThreadResumeFallback() {
  const completedTraeThread = {
    activeCommand: null,
    lastThreadId: "thread-trae-recent",
    lastThreadProvider: "traex",
  };
  const resolved = resolveAgentThreadToResume(completedTraeThread);
  assert.deepEqual(resolved, {
    provider: "traex",
    threadId: "thread-trae-recent",
  });
  assert.equal(
    buildAgentResumeCommand(resolved),
    "traex resume thread-trae-recent\n",
  );

  assert.equal(
    resolveAgentThreadToResume({
      ...completedTraeThread,
      activeCommand: "codex",
    }),
    null,
  );
  assert.equal(
    resolveAgentThreadToResume({
      ...completedTraeThread,
      lastThreadId: "",
    }),
    null,
  );
  assert.equal(
    resolveAgentThreadToResume({
      ...completedTraeThread,
      lastThreadProvider: undefined,
    }),
    null,
  );
}

async function verifyDelayedCrossProviderHookGuard() {
  const mutations = [];
  const session = {
    id: "terminal-provider-switch",
    projectId: "project-provider-switch",
    status: "running",
    activeCommand: "codex",
    threadId: "codex-current",
    threadProvider: "codex",
    terminalState: { state: "agent_idle", agent: "codex" },
  };
  const panel = {
    id: "panel-provider-switch",
    terminalSessionId: session.id,
    tmuxPaneId: "%77",
    status: "running",
    activeCommand: "codex",
    threadId: "codex-current",
    threadProvider: "codex",
    terminalState: { state: "agent_idle", agent: "codex" },
  };
  const terminalSessionManager = {
    getSession: () => session,
    getPanel: () => undefined,
    listPanels: () => [panel],
    getLastAiActiveCommand: () => null,
    updatePanelTerminalState: async (...args) => mutations.push(args),
    updateSessionLastThread: async (...args) => mutations.push(args),
    updatePanelLastThread: async (...args) => mutations.push(args),
    updateSessionThreadId: async (...args) => mutations.push(args),
    updateSessionPreview: async (...args) => mutations.push(args),
    updatePanelThreadId: async (...args) => mutations.push(args),
    updatePanelPreview: async (...args) => mutations.push(args),
  };
  const terminalStateService = {
    getCurrent: () => session.terminalState,
    handleAgentHook: (...args) => {
      mutations.push(args);
      return { state: "agent_running", agent: "trae" };
    },
  };
  const result = await processTerminalAgentHook(
    { terminalSessionManager, terminalStateService },
    {
      terminalSessionId: session.id,
      agent: "trae",
      hookEvent: "UserPromptSubmit",
      threadId: "stale-trae-thread",
      panelId: "stale-panel",
      tmuxPaneId: panel.tmuxPaneId,
      commandName: "traex",
    },
  );

  assert.equal(result.status, "ignored");
  assert.equal(result.agent, "trae");
  assert.equal(result.panelId, panel.id);
  assert.equal(session.threadId, "codex-current");
  assert.equal(session.threadProvider, "codex");
  assert.equal(panel.threadId, "codex-current");
  assert.equal(panel.threadProvider, "codex");
  assert.equal(mutations.length, 0);
}

async function verifyTmuxPaneFallbackUniqueness() {
  const session = {
    id: "terminal-pane-fallback",
    projectId: "project-pane-fallback",
    status: "running",
    activeCommand: "traex",
    terminalState: { state: "agent_idle", agent: "trae" },
  };
  const makePanel = (id, tmuxPaneId) => ({
    id,
    terminalSessionId: session.id,
    tmuxPaneId,
    status: "running",
    activeCommand: "traex",
    terminalState: { state: "agent_idle", agent: "trae" },
  });
  const run = async (panels) => {
    const mutations = [];
    const terminalSessionManager = {
      getSession: () => session,
      getPanel: () => undefined,
      listPanels: () => panels,
      getLastAiActiveCommand: () => null,
      updatePanelTerminalState: async (...args) => mutations.push(args),
    };
    const terminalStateService = {
      getCurrent: () => session.terminalState,
      handleAgentHook: (...args) => {
        mutations.push(args);
        return { state: "agent_running", agent: "trae" };
      },
    };
    const result = await processTerminalAgentHook(
      { terminalSessionManager, terminalStateService },
      {
        terminalSessionId: session.id,
        agent: "trae",
        hookEvent: "SessionStart",
        panelId: "invalid-panel",
        tmuxPaneId: "%0",
        commandName: "traex",
      },
    );
    return { mutations, result };
  };

  const unique = await run([makePanel("panel-a", "%0")]);
  assert.equal(unique.result.status, "recorded");
  assert.equal(unique.result.panelId, "panel-a");
  assert.equal(unique.mutations.length, 2);

  const duplicate = await run([
    makePanel("panel-a", "%0"),
    makePanel("panel-b", "%0"),
  ]);
  assert.equal(duplicate.result.status, "ignored");
  assert.equal(duplicate.result.panelId, null);
  assert.equal(duplicate.mutations.length, 0);

  const missing = await run([makePanel("panel-c", "%1")]);
  assert.equal(missing.result.status, "ignored");
  assert.equal(missing.result.panelId, null);
  assert.equal(missing.mutations.length, 0);
}
