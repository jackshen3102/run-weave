import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runToolkitHookCommand } from "./helpers.mjs";

export async function verifyPtyProviderLifecycle(params) {
  const baseEnv = {
    HOME: params.homeDir,
    RUNWEAVE_TOOLKIT_PLUGIN_ROOT: fileURLToPath(new URL("../../../plugins/toolkit", import.meta.url)),
    RUNWEAVE_APP_SERVER_URL: params.appServerUrl,
    RUNWEAVE_APP_SERVER_TOKEN: "app-server-token",
    RUNWEAVE_HOOK_ENDPOINT: params.endpoint,
    RUNWEAVE_COMPLETION_HOOK_ENDPOINT: params.completionEndpoint,
    RUNWEAVE_PROJECT_ID: "project-pty-provider",
    RUNWEAVE_HOOK_SUPPRESS_DESKTOP_NOTIFY: "1",
  };
  const ptyOptions = { omitTmuxPane: true, replacePluginDirPlaceholder: false, setHookSource: false };
  // Plain PTY hooks must register the exact Trae provider without tmux context.
  for (const source of ["traex", "traecli"]) {
    const terminalSessionId = `terminal-pty-${source}`;
    const threadId = `thread-pty-${source}`;
    for (const hookEvent of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      const start = params.requests.length;
      await runToolkitHookCommand(
        params.userPromptCommand,
        source,
        { ...baseEnv, RUNWEAVE_HOOK_TOKEN: `token-pty-${source}`, RUNWEAVE_TERMINAL_SESSION_ID: terminalSessionId },
        { hook_event_name: hookEvent, session_id: threadId },
        { ...ptyOptions, setHookSource: true },
      );
      const hook = params.requests.slice(start).find(request => request.url === "/internal/terminal/agent-hook");
      assert.ok(hook, `${source} ${hookEvent} must register terminal lifecycle`);
      assert.equal(hook.body.agent, source);
      assert.equal(hook.body.threadId, threadId);
      assert.equal(hook.body.terminalSessionId, terminalSessionId);
      assert.equal(hook.body.hookEvent, hookEvent);
      assert.equal(hook.body.tmuxPaneId, undefined);
    }
  }
  const inferenceStart = params.requests.length;
  await runToolkitHookCommand(
    `node hooks/runweave-hook-dispatch.cjs --command-name 'C:\\Tools\\Traex.exe'`,
    "unknown",
    { ...baseEnv, RUNWEAVE_HOOK_TOKEN: "token-pty-exe", RUNWEAVE_TERMINAL_SESSION_ID: "terminal-pty-exe" },
    { hook_event_name: "SessionStart", thread_id: "thread-pty-exe" },
    ptyOptions,
  );
  const inferred = params.requests.slice(inferenceStart).find(request => request.url === "/internal/terminal/agent-hook");
  if (process.platform === "win32") {
    assert.ok(inferred, "Windows executable must infer Traex lifecycle");
    assert.equal(inferred.body.agent, "traex");
    assert.equal(inferred.body.threadId, "thread-pty-exe");
  } else {
    assert.equal(inferred, undefined, "POSIX must not infer a provider from a Windows executable name");
  }
}
