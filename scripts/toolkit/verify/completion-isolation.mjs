import assert from "node:assert/strict";
import {
  getToolkitHookCommand,
  runToolkitHookCommand,
  verifyTraexNotificationCompletion,
} from "./helpers.mjs";

export async function verifyCompletionHookIsolation(params) {
  await verifyTraexNotificationCompletion({
    ...params,
    command: getToolkitHookCommand(params.toolkitHooksConfig, "Notification"),
  });

  const requestsBeforeSubagentStop = params.requests.length;
  const appServerRequestsBeforeSubagentStop = params.appServerRequests.length;
  for (const source of ["codex", "trae", "claude"]) {
    for (const event of ["SubagentStop", "subagent_stop", "subagent-stop"]) {
      await runToolkitHookCommand(
        getToolkitHookCommand(params.toolkitHooksConfig, "SubagentStop"),
        source,
        {
          HOME: params.homeDir,
          RUNWEAVE_APP_SERVER_URL: params.appServerUrl,
          RUNWEAVE_APP_SERVER_TOKEN: "app-server-token",
          RUNWEAVE_HOOK_ENDPOINT: params.endpoint,
          RUNWEAVE_HOOK_TOKEN: "token-subagent",
          RUNWEAVE_TERMINAL_SESSION_ID: "terminal-parent",
          RUNWEAVE_TERMINAL_PANEL_ID: "panel-parent",
          RUNWEAVE_PROJECT_ID: "project-parent",
        },
        { hook_event_name: event, session_id: "thread-parent" },
      );
    }
  }
  assert.equal(
    params.requests.length,
    requestsBeforeSubagentStop,
    "subagent completion must not update parent state or send completion notifications",
  );
  assert.equal(
    params.appServerRequests.length,
    appServerRequestsBeforeSubagentStop,
    "subagent completion must not enter parent Activity or task supervision",
  );
}
