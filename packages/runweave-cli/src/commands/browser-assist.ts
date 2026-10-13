import { scheduledBrowserGroupId } from "@runweave/shared/scheduled-tasks";
import { BrowserCdpClient } from "../client/browser-cdp.js";
import { resolveBrowserProfile, type BrowserCommandIo } from "./browser-profile.js";
import type {
  BrowserAssistanceRequest,
  CreateBrowserAssistanceRequest,
} from "@runweave/shared/terminal-browser-assistance";
import { isTerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
import {
  getStringOption,
  parseArgs,
  requireStringOption,
  resolveOutputMode,
} from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { TerminalHttpClient } from "../client/terminal-http-client.js";
import { CliError } from "../errors.js";
import { writeOutput } from "../output/format.js";

export async function runBrowserAssistCommand(
  args: string[],
  io: BrowserCommandIo,
) {
  const [action, ...rest] = args;
  if (
    !action ||
    !["request", "status", "acknowledge", "cancel"].includes(action)
  ) {
    throw new CliError(
      "Usage: rw browser assist <request|status|acknowledge|cancel> [request-id] [--json]",
      2,
    );
  }
  const parsed = parseArgs(rest, new Set(["json", "plain"]));
  const allowed = new Set([
    "json",
    "plain",
    "backend-port",
    "profile",
    "browser-profile",
    "group-id",
    "target-id",
    "reason",
  ]);
  for (const key of Object.keys(parsed.options)) {
    if (!allowed.has(key)) throw new CliError(`Unknown option --${key}`, 2);
  }
  const sessionId = io.env.RUNWEAVE_TERMINAL_SESSION_ID?.trim();
  if (!sessionId) {
    const runId = io.env.RUNWEAVE_SCHEDULED_TASK_RUN_ID?.trim();
    if (!runId)
      throw new CliError(
        "Run inside a Runweave Terminal panel or scheduled task",
        2,
      );
    if (action !== "request" || parsed.positionals.length)
      throw new CliError(
        "Background assistance is returned in the final task result; use the run record to take over the conversation",
        2,
      );
    const groupId = requireStringOption(parsed.options, "group-id");
    if (groupId !== scheduledBrowserGroupId(runId))
      throw new CliError(
        "Browser group does not belong to this scheduled run",
        2,
      );
    const profile = requireStringOption(parsed.options, "browser-profile");
    const targetId = requireStringOption(parsed.options, "target-id");
    const reason = requireStringOption(parsed.options, "reason").trim();
    if (!reason || reason.length > 2000)
      throw new CliError("Reason must contain 1-2000 characters", 2);
    const resolved = await resolveBrowserProfile(
      ["--profile", profile, "--group-id", groupId],
      io,
    );
    const cdp = await BrowserCdpClient.connect(resolved.cdpEndpoint);
    try {
      const { targetInfos } = await cdp.send<{
        targetInfos: Array<{ targetId: string }>;
      }>("Target.getTargets");
      if (!targetInfos.some((target) => target.targetId === targetId))
        throw new CliError(
          "Assistance target is closed or outside this Profile/Group",
          4,
        );
    } finally {
      cdp.close();
    }
    // No terminal impersonation or second executor. The provider persists this
    // request atomically with the result when the Agent returns it and exits.
    writeOutput(io.stdout, resolveOutputMode(parsed.options), {
      outcome: "blocked",
      summary: `等待浏览器协助：${reason}`,
      reason,
      recovery: {
        action: "needs-input",
        category: "input",
        evidence: "已核对协助页面属于本次运行的浏览器分组。",
        nextStep:
          "在运行记录中准备并进入原会话，打开协助页面。完成页面操作后交还 Agent，由 Agent 重新观察并继续。",
        notBefore: null,
        confirmation: null,
        browser: {
          profileId: resolved.profileId,
          browserGroupId: groupId,
          targetId,
        },
      },
    });
    return;
  }
  const auth = await resolveAuthContext({
    env: io.env,
    profileName: getStringOption(parsed.options, "profile"),
    backendPort: getStringOption(parsed.options, "backend-port"),
  });
  // Initial shells can predate Panel registration. Resolve the caller's pane,
  // never the UI's active panel; a stale inherited panel ID is not authority.
  const paneId = io.env.TMUX_PANE?.trim();
  let panelId = io.env.RUNWEAVE_TERMINAL_PANEL_ID?.trim();
  if (paneId) {
    const workspace = await new TerminalHttpClient(auth).listPanels(sessionId);
    const matches = workspace.panels.filter(
      (panel) => panel.tmuxPaneId === paneId,
    );
    panelId = matches.length === 1 ? matches[0]!.panelId : undefined;
  }
  if (!panelId)
    throw new CliError("Unable to resolve the requesting Terminal panel", 2);
  const base = `/api/terminal/session/${encodeURIComponent(sessionId)}/browser-assistance`;
  let result: BrowserAssistanceRequest | BrowserAssistanceRequest[];
  if (action === "request") {
    if (parsed.positionals.length)
      throw new CliError("request does not accept a request id", 2);
    const profileId = `profile-${requireStringOption(parsed.options, "browser-profile")}`;
    if (!isTerminalBrowserProfileId(profileId))
      throw new CliError("--browser-profile must be 1, 2 or 3", 2);
    const body: CreateBrowserAssistanceRequest = {
      panelId,
      profileId,
      browserGroupId: requireStringOption(parsed.options, "group-id"),
      targetId: requireStringOption(parsed.options, "target-id"),
      reason: requireStringOption(parsed.options, "reason"),
    };
    result = await auth.requestJson<BrowserAssistanceRequest>(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } else {
    const id = parsed.positionals[0];
    if (parsed.positionals.length > 1 || (!id && action !== "status")) {
      throw new CliError(`${action} requires one request id`, 2);
    }
    const path = id ? `${base}/${encodeURIComponent(id)}` : base;
    result =
      action === "status"
        ? await auth.requestJson<
            BrowserAssistanceRequest | BrowserAssistanceRequest[]
          >(path)
        : await auth.requestJson<BrowserAssistanceRequest>(
            `${path}/${action}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ panelId }),
            },
          );
  }
  writeOutput(io.stdout, resolveOutputMode(parsed.options), result);
}
