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
  io: { stdout: Pick<NodeJS.WriteStream, "write">; env: NodeJS.ProcessEnv },
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
  if (!sessionId)
    throw new CliError("Run inside the requesting Runweave Terminal panel", 2);
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
