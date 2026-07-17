import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import {
  assertFileMissing,
  getToolkitHookCommand,
  runLauncher,
  runToolkitHookCommand,
  verifyPtyProviderInference,
  verifyPreToolHook,
  verifyTmuxPaneContextFailure,
  writeAppServerDiscoveryFiles,
} from "./verify-toolkit-hooks-helpers.mjs";
import { createToolkitHookFixture } from "./verify-toolkit-hooks/fixture.mjs";
import { verifyToolkitHookProviderGuards } from "./verify-toolkit-hooks/provider-guards.mjs";

const fixture = await createToolkitHookFixture();
const {
  cleanup,
  codexToolkitDir,
  fakeTmuxPath,
  homeDir,
  launcherPath,
  toolkitDir,
  toolkitHooksConfig,
  traeToolkitDir,
} = fixture;
try {
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

    const isolatedAppServerHome = path.join(homeDir, "isolated-app-server");
    await writeAppServerDiscoveryFiles(
      isolatedAppServerHome,
      appServerPort,
      "app-server-token",
    );
    const homeDiscoveryStart = appServerRequests.length;
    await runLauncher(launcherPath, {
      HOME: homeDir,
      RUNWEAVE_APP_SERVER_HOME: isolatedAppServerHome,
      RUNWEAVE_HOOK_ENDPOINT: endpoint,
      RUNWEAVE_COMPLETION_HOOK_ENDPOINT: `http://127.0.0.1:${port}/internal/terminal-completion`,
      RUNWEAVE_HOOK_TOKEN: "token-home-discovery",
      RUNWEAVE_TERMINAL_SESSION_ID: "terminal-home-discovery",
      RUNWEAVE_PROJECT_ID: "project-home-discovery",
      RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
    });
    assert.equal(
      appServerRequests.length - homeDiscoveryStart,
      2,
      "RUNWEAVE_APP_SERVER_HOME must target the isolated App Server",
    );

    const globalAppServerHome = path.join(homeDir, ".runweave", "app-server");
    await writeAppServerDiscoveryFiles(
      globalAppServerHome,
      appServerPort,
      "app-server-token",
    );
    const explicitDiscoveryStart = appServerRequests.length;
    await runLauncher(launcherPath, {
      HOME: homeDir,
      RUNWEAVE_APP_SERVER_DISCOVERY: "explicit",
      RUNWEAVE_HOOK_ENDPOINT: endpoint,
      RUNWEAVE_COMPLETION_HOOK_ENDPOINT: `http://127.0.0.1:${port}/internal/terminal-completion`,
      RUNWEAVE_HOOK_TOKEN: "token-explicit-discovery",
      RUNWEAVE_TERMINAL_SESSION_ID: "terminal-explicit-discovery",
      RUNWEAVE_PROJECT_ID: "project-explicit-discovery",
      RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
    });
    assert.equal(
      appServerRequests.length,
      explicitDiscoveryStart,
      "explicit discovery must not fall back to the global App Server",
    );

    const disabledDiscoveryStart = appServerRequests.length;
    await runLauncher(launcherPath, {
      HOME: homeDir,
      RUNWEAVE_APP_SERVER_DISCOVERY: "disabled",
      RUNWEAVE_APP_SERVER_URL: `http://127.0.0.1:${appServerPort}`,
      RUNWEAVE_APP_SERVER_TOKEN: "app-server-token",
      RUNWEAVE_HOOK_ENDPOINT: endpoint,
      RUNWEAVE_COMPLETION_HOOK_ENDPOINT: `http://127.0.0.1:${port}/internal/terminal-completion`,
      RUNWEAVE_HOOK_TOKEN: "token-disabled-discovery",
      RUNWEAVE_TERMINAL_SESSION_ID: "terminal-disabled-discovery",
      RUNWEAVE_PROJECT_ID: "project-disabled-discovery",
      RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
    });
    assert.equal(
      appServerRequests.length,
      disabledDiscoveryStart,
      "disabled discovery must not contact an App Server",
    );
    requests.length = 0;
    appServerRequests.length = 0;

    await runLauncher(launcherPath, {
      HOME: homeDir,
      RUNWEAVE_APP_SERVER_URL: `http://127.0.0.1:${appServerPort}`,
      RUNWEAVE_APP_SERVER_TOKEN: "app-server-token",
      RUNWEAVE_HOOK_ENDPOINT: endpoint,
      RUNWEAVE_COMPLETION_HOOK_ENDPOINT: `http://127.0.0.1:${port}/internal/terminal-completion`,
      RUNWEAVE_HOOK_TOKEN: "token-1",
      RUNWEAVE_TERMINAL_SESSION_ID: "terminal-1",
      RUNWEAVE_TERMINAL_AGENT_OPERATION_ID: "operation-1",
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
    assert.deepEqual(requests[0].body, {
      activityEventId: requests[0].body.activityEventId,
      terminalSessionId: "terminal-1",
      projectId: "project-1",
      tmuxPaneId: "%13",
      threadId: "thread-1",
      operationId: "operation-1",
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
    assert.equal(requests[1].body.operationId, "operation-1");

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
    assert.deepEqual(requests[2].body, {
      activityEventId: requests[2].body.activityEventId,
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
    assert.deepEqual(requests[4].body, {
      activityEventId: requests[4].body.activityEventId,
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
    assert.equal(appServerRequests[7].scope.terminalPanelId, "panel-pane-3");
    assert.equal(appServerRequests[8].kind, "agent.completion");
    assert.equal(appServerRequests[8].payload.source, "trae");
    assert.equal(requests[7].url, "/internal/terminal/agent-hook");
    assert.equal(requests[7].token, "token-3");
    assert.deepEqual(requests[7].body, {
      activityEventId: requests[7].body.activityEventId,
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

    await verifyTmuxPaneContextFailure({
      command: getToolkitHookCommand(toolkitHooksConfig, "Stop"),
      homeDir,
      appServerUrl: `http://127.0.0.1:${appServerPort}`,
      endpoint,
      completionEndpoint: `http://127.0.0.1:${port}/internal/terminal-completion`,
      fakeTmuxPath,
      requests,
      appServerRequests,
    });

    const requestsBeforeIdentitylessLauncher = requests.length;
    const appServerRequestsBeforeIdentitylessLauncher =
      appServerRequests.length;
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
      requestsBeforeIdentitylessLauncher,
      "launcher without Runweave identity must not post any request",
    );
    assert.equal(
      appServerRequests.length,
      appServerRequestsBeforeIdentitylessLauncher,
      "launcher without Runweave identity must not post app-server events",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => appServer.close(resolve));
  }
} finally {
  await cleanup();
}

await verifyToolkitHookProviderGuards();

console.log("toolkit hook verification passed");
