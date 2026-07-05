import type { AgentTeamExportResponse } from "@runweave/shared";
import { getStringOption, parseArgs, resolveOutputMode } from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { TerminalHttpClient } from "../client/terminal-http-client.js";
import { CliError } from "../errors.js";
import { writeOutput } from "../output/format.js";

export async function runAgentTeamCommand(
  subcommand: string | undefined,
  args: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    stdin: NodeJS.ReadStream;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  if (!subcommand) {
    throw new CliError("Usage: rw agent-team <export> [options]", 2);
  }
  const parsed = parseArgs(args, new Set(["json", "plain"]));
  const mode = resolveOutputMode(parsed.options);
  const auth = await resolveAuthContext({
    profileName: getStringOption(parsed.options, "profile"),
    backendPort: getStringOption(parsed.options, "backend-port"),
    env: io.env,
  });
  const client = new TerminalHttpClient(auth);

  if (subcommand === "export") {
    const runId = await resolveRunId(client, parsed.positionals[0], parsed.options);
    const payload = await client.exportAgentTeamRun(runId, {
      history: resolveHistoryMode(getStringOption(parsed.options, "history")),
      tail: resolveTail(getStringOption(parsed.options, "tail")),
      includeSessionOther: resolveOptionalBoolean(
        getStringOption(parsed.options, "include-session-other"),
        "--include-session-other",
      ),
      includeOutboxes: resolveOptionalBoolean(
        getStringOption(parsed.options, "include-outboxes"),
        "--include-outboxes",
      ),
    });
    writeOutput(
      io.stdout,
      mode,
      mode === "json" ? payload : formatPlainExport(payload),
    );
    return;
  }

  throw new CliError(`Unknown agent-team command: ${subcommand}`, 2);
}

async function resolveRunId(
  client: TerminalHttpClient,
  positionalRunId: string | undefined,
  options: Record<string, string | boolean>,
): Promise<string> {
  if (positionalRunId) {
    return positionalRunId;
  }
  const projectId = getStringOption(options, "project-id");
  const terminalSessionId = getStringOption(options, "terminal-session-id");
  if (!projectId || !terminalSessionId) {
    throw new CliError(
      "Missing runId. Pass rw agent-team export <runId> or --project-id plus --terminal-session-id.",
      2,
    );
  }
  const response = await client.listAgentTeamRuns(projectId, terminalSessionId);
  if (response.runs.length === 0) {
    throw new CliError("No agent-team run found for the terminal session", 1);
  }
  if (response.runs.length > 1) {
    throw new CliError("Multiple agent-team runs found; pass runId explicitly", 1);
  }
  return response.runs[0]!.runId;
}

function resolveOptionalBoolean(
  value: string | undefined,
  optionName: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new CliError(`${optionName} must be true or false`, 2);
}

function resolveHistoryMode(
  value: string | undefined,
): "none" | "tail" | "full" | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "none" || value === "tail" || value === "full") {
    return value;
  }
  throw new CliError("--history must be one of: none, tail, full", 2);
}

function resolveTail(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5000) {
    throw new CliError("--tail must be an integer between 1 and 5000", 2);
  }
  return parsed;
}

function formatPlainExport(payload: AgentTeamExportResponse): string {
  const lines = [
    `Run: ${payload.run.runId}`,
    `Status: ${payload.run.phase}/${payload.run.status}`,
    `Terminal: ${payload.run.terminalSessionId}`,
    `Generated: ${payload.generatedAt}`,
    "",
    "Panels:",
    ...payload.panels.runBound.map(
      (panel) =>
        `- ${panel.source} ${panel.workerRole} panel=${panel.panelId} pane=${panel.tmuxPaneId ?? "null"} alias=${panel.alias ?? "null"}`,
    ),
  ];
  if (payload.panels.sessionOther.length > 0) {
    lines.push(
      "",
      "Session other panels:",
      ...payload.panels.sessionOther.map(
        (panel) =>
          `- panel=${panel.panelId} pane=${panel.tmuxPaneId ?? "null"} alias=${panel.alias ?? "null"} role=${panel.role ?? "null"}`,
      ),
    );
  }
  lines.push(
    "",
    "Acceptance:",
    ...payload.acceptanceSummary.map(
      (item) =>
        `- ${item.caseId}: ${item.status}, evidence=${item.evidenceCount}, roles=${item.sourceRoles.join(",") || "none"}, remainingFindings=${item.remainingFindingCount}, resolvedFindings=${item.resolvedFindingCount}`,
    ),
    "",
    "Outboxes:",
    ...payload.outboxes.map(
      (item) =>
        `- ${item.exists ? "exists" : "missing"} ${item.scope} panel=${item.panelId ?? "null"} pane=${item.tmuxPaneId ?? "null"} path=${item.path}`,
    ),
  );
  if (payload.warnings.length > 0) {
    lines.push("", "Warnings:", ...payload.warnings.map((item) => `- ${item}`));
  }
  return lines.join("\n");
}
