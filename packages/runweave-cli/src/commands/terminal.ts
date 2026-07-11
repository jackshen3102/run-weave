import {
  getBooleanOption,
  getStringOption,
  parseArgs,
  requireStringOption,
  resolveOutputMode,
} from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { TerminalHttpClient } from "../client/terminal-http-client.js";
import { CliError } from "../errors.js";
import {
  buildOperationId,
  commandName,
  DEFAULT_AGENT_START_TIMEOUT_MS,
  DEFAULT_CONFIRM_TIMEOUT_MS,
  inferHandoffWorkloadState,
  sendWithConfirmation,
} from "./terminal-agent.js";
import { tailLines, writeOutput } from "../output/format.js";
import type { TerminalInputMode } from "@runweave/shared/terminal/input";
import type { TerminalPanelWorkspace } from "@runweave/shared/terminal/panel";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { TerminalSessionListItem, TerminalSessionStatusResponse } from "@runweave/shared/terminal/session";
import type { TerminalState } from "@runweave/shared/terminal/state";

const DEFAULT_TAIL_LINES = 120;
const MAX_STDIN_BYTES = 256 * 1024;

export async function runTerminalCommand(
  subcommand: string | undefined,
  args: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    stdin: NodeJS.ReadStream;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  if (!subcommand) {
    throw new CliError(
      "Usage: rw terminal <create|list|show|snapshot|handoff|send|interrupt|state|history|delete|panel>",
      2,
    );
  }

  const createArgScan =
    subcommand === "create"
      ? extractRepeatedOption(args, "arg")
      : { args, values: [] };
  const parsed = parseArgs(
    createArgScan.args,
    new Set(["json", "plain", "enter", "stdin", "agent-overwrite"]),
  );
  const mode = resolveOutputMode(parsed.options);
  const auth = await resolveAuthContext({
    profileName: getStringOption(parsed.options, "profile"),
    backendPort: getStringOption(parsed.options, "backend-port"),
    env: io.env,
  });
  const client = new TerminalHttpClient(auth);

  if (subcommand === "panel") {
    const panelCommand = parsed.positionals[0];
    const terminalSessionId = parsed.positionals[1];
    if (!panelCommand || !terminalSessionId) {
      throw new CliError(
        "Usage: rw terminal panel <list|split|focus|close> <terminalSessionId>",
        2,
      );
    }

    if (panelCommand === "list") {
      writeOutput(io.stdout, mode, await client.listPanels(terminalSessionId));
      return;
    }

    if (panelCommand === "split") {
      const workspace = await client.listPanels(terminalSessionId);
      const from = getStringOption(parsed.options, "from");
      const direction = requireStringOption(parsed.options, "direction");
      if (direction !== "right" && direction !== "down") {
        throw new CliError("--direction must be one of: right, down", 2);
      }
      const sourcePanel = from
        ? resolvePanelIdentifier(workspace, from)
        : workspace.panels.find((panel) => panel.focused) ?? workspace.panels[0];
      const result = await client.createPanel(terminalSessionId, {
        sourcePanelId: sourcePanel?.panelId,
        direction,
        alias: getStringOption(parsed.options, "alias") ?? null,
        role: getStringOption(parsed.options, "role") ?? null,
      });
      writeOutput(io.stdout, mode, result);
      return;
    }

    if (panelCommand === "focus") {
      const target = parsed.positionals[2] ?? getStringOption(parsed.options, "panel");
      if (!target) {
        throw new CliError("Missing panel id or alias", 2);
      }
      const workspace = await client.listPanels(terminalSessionId);
      const panel = resolvePanelIdentifier(workspace, target);
      writeOutput(
        io.stdout,
        mode,
        await client.focusPanel(terminalSessionId, panel.panelId),
      );
      return;
    }

    if (panelCommand === "close") {
      const target = parsed.positionals[2] ?? getStringOption(parsed.options, "panel");
      if (!target) {
        throw new CliError("Missing panel id or alias", 2);
      }
      const workspace = await client.listPanels(terminalSessionId);
      const panel = resolvePanelIdentifier(workspace, target);
      writeOutput(
        io.stdout,
        mode,
        await client.closePanel(terminalSessionId, panel.panelId),
      );
      return;
    }

    throw new CliError(`Unknown terminal panel command: ${panelCommand}`, 2);
  }

  if (subcommand === "create") {
    const inheritFromTerminalSessionId = getStringOption(
      parsed.options,
      "inherit-from",
    );
    const projectId = inheritFromTerminalSessionId
      ? getStringOption(parsed.options, "project-id")
      : requireStringOption(parsed.options, "project-id");
    const cwd = inheritFromTerminalSessionId
      ? getStringOption(parsed.options, "cwd")
      : requireStringOption(parsed.options, "cwd");
    const payload = await client.createSession({
      projectId,
      cwd,
      command: getStringOption(parsed.options, "command"),
      args: createArgScan.values.length > 0 ? createArgScan.values : undefined,
      inheritFromTerminalSessionId,
      runtimePreference:
        (getStringOption(parsed.options, "runtime") as
          | "auto"
          | "tmux"
          | "pty"
          | undefined) ?? "auto",
    });
    writeOutput(io.stdout, mode, payload);
    return;
  }

  if (subcommand === "list") {
    writeOutput(io.stdout, mode, await client.listSessions());
    return;
  }

  if (subcommand === "show") {
    const terminalSessionId = requireTerminalId(parsed.positionals);
    writeOutput(io.stdout, mode, await client.getSession(terminalSessionId));
    return;
  }

  if (subcommand === "snapshot") {
    const terminalSessionId = requireTerminalId(parsed.positionals);
    const panelSelector =
      getStringOption(parsed.options, "panel") ??
      getStringOption(parsed.options, "role");
    const session = panelSelector
      ? await client.getPanelHistory(
          terminalSessionId,
          resolvePanelIdentifier(
            await client.listPanels(terminalSessionId),
            panelSelector,
          ).panelId,
        )
      : await client.getSessionHistory(terminalSessionId);
    const tail = tailLines(session.scrollback, resolveTail(parsed.options));
    writeOutput(io.stdout, mode, mode === "json" ? { ...session, tail } : tail);
    return;
  }

  if (subcommand === "handoff") {
    const terminalSessionId = requireTerminalId(parsed.positionals);
    const [projects, sessions, session, statePayload, panels] = await Promise.all([
      client.listProjects(),
      client.listSessions(),
      client.getSession(terminalSessionId),
      client.getCurrentTerminalState(terminalSessionId),
      client.listPanels(terminalSessionId).catch(() => null),
    ]);
    writeOutput(
      io.stdout,
      mode,
      buildHandoff(
        session,
        projects,
        sessions,
        resolveTail(parsed.options),
        statePayload.terminalState,
        panels,
      ),
    );
    return;
  }

  if (subcommand === "state") {
    const terminalSessionId = requireTerminalId(parsed.positionals);
    const statePayload = await client.getCurrentTerminalState(terminalSessionId);
    writeOutput(
      io.stdout,
      mode,
      {
        terminalSessionId,
        terminalState: statePayload.terminalState,
      },
    );
    return;
  }

  if (subcommand === "history") {
    const terminalSessionId = requireTerminalId(parsed.positionals);
    const panelSelector =
      getStringOption(parsed.options, "panel") ??
      getStringOption(parsed.options, "role");
    const session = panelSelector
      ? await client.getPanelHistory(
          terminalSessionId,
          resolvePanelIdentifier(
            await client.listPanels(terminalSessionId),
            panelSelector,
          ).panelId,
        )
      : await client.getSessionHistory(terminalSessionId);
    const tail = tailLines(session.scrollback, resolveTail(parsed.options));
    writeOutput(io.stdout, mode, mode === "json" ? { ...session, tail } : tail);
    return;
  }

  if (subcommand === "send") {
    const terminalSessionId = requireTerminalId(parsed.positionals);
    const requestedAgent = getStringOption(parsed.options, "agent");
    const inputModeValue = getStringOption(parsed.options, "mode");
    const result = await sendWithConfirmation({
      client,
      terminalSessionId,
      text: await resolveInputText(parsed.options, io.stdin),
      enter: getBooleanOption(parsed.options, "enter"),
      inputMode: resolveInputMode(
        inputModeValue ?? (requestedAgent ? "line" : undefined),
      ),
      inputModeProvided: inputModeValue != null || requestedAgent != null,
      panel: getStringOption(parsed.options, "panel"),
      role: getStringOption(parsed.options, "role"),
      confirmMode: getStringOption(parsed.options, "confirm") ?? "none",
      confirmTimeoutMs: Number(
        getStringOption(parsed.options, "confirm-timeout-ms") ??
          DEFAULT_CONFIRM_TIMEOUT_MS,
      ),
      agent: requestedAgent,
      agentOverwrite: getBooleanOption(parsed.options, "agent-overwrite"),
      agentStartCommand: getStringOption(parsed.options, "agent-start-command"),
      agentClearCommand:
        getStringOption(parsed.options, "agent-clear-command") ?? "/clear",
      agentExitCommand: getStringOption(parsed.options, "agent-exit-command"),
      agentStartTimeoutMs: Number(
        getStringOption(parsed.options, "agent-start-timeout-ms") ??
          DEFAULT_AGENT_START_TIMEOUT_MS,
      ),
    });
    writeOutput(io.stdout, mode, result);
    return;
  }

  if (subcommand === "delete") {
    const terminalSessionId = requireTerminalId(parsed.positionals);
    await client.deleteSession(terminalSessionId);
    writeOutput(io.stdout, mode, {
      terminalSessionId,
      deleted: true,
    });
    return;
  }

  if (subcommand === "interrupt") {
    const terminalSessionId = requireTerminalId(parsed.positionals);
    const result = await client.interruptSession(terminalSessionId, {
      operationId: buildOperationId(),
      panelAlias: getStringOption(parsed.options, "panel"),
      role: getStringOption(parsed.options, "role"),
    });
    writeOutput(io.stdout, mode, {
      ...result,
      transport: "http",
    });
    return;
  }

  throw new CliError(`Unknown terminal command: ${subcommand}`, 2);
}

function requireTerminalId(positionals: string[]): string {
  const terminalSessionId = positionals[0];
  if (!terminalSessionId) {
    throw new CliError("Missing terminal session id", 2);
  }
  return terminalSessionId;
}

function resolveTail(options: Record<string, string | boolean>): number {
  const rawTail = getStringOption(options, "tail");
  if (!rawTail) {
    return DEFAULT_TAIL_LINES;
  }
  const tail = Number(rawTail);
  if (!Number.isInteger(tail) || tail < 0) {
    throw new CliError("--tail must be a non-negative integer", 2);
  }
  return tail;
}

function resolveInputMode(value: string | undefined): TerminalInputMode {
  if (!value) {
    return "raw";
  }
  if (
    value === "raw" ||
    value === "line" ||
    value === "codex_slash_command" ||
    value === "prompt_paste" ||
    value === "prompt_replace"
  ) {
    return value;
  }
  throw new CliError(
    "--mode must be one of: raw, line, codex_slash_command, prompt_paste, prompt_replace",
    2,
  );
}

function resolvePanelIdentifier(
  workspace: TerminalPanelWorkspace,
  value: string,
): TerminalPanelWorkspace["panels"][number] {
  const matches = workspace.panels.filter(
    (panel) =>
      panel.panelId === value || panel.alias === value || panel.role === value,
  );
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new CliError(
      `Panel selector matches multiple panels: ${matches
        .map((panel) => panel.panelId)
        .join(", ")}`,
      4,
    );
  }
  throw new CliError(`Panel not found: ${value}`, 4);
}

function extractRepeatedOption(
  args: string[],
  optionName: string,
): { args: string[]; values: string[] } {
  const filteredArgs: string[] = [];
  const values: string[] = [];
  const option = `--${optionName}`;
  const optionPrefix = `${option}=`;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg == null) {
      continue;
    }
    if (arg === option) {
      const value = args[index + 1];
      if (value == null) {
        throw new CliError(`Missing value for --${optionName}`, 2);
      }
      values.push(value);
      index += 1;
      continue;
    }
    if (arg?.startsWith(optionPrefix)) {
      values.push(arg.slice(optionPrefix.length));
      continue;
    }
    filteredArgs.push(arg);
  }

  return { args: filteredArgs, values };
}

async function resolveInputText(
  options: Record<string, string | boolean>,
  stdin: NodeJS.ReadStream,
): Promise<string> {
  if (getBooleanOption(options, "stdin")) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stdin) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk));
      size += buffer.byteLength;
      if (size > MAX_STDIN_BYTES) {
        throw new CliError("stdin input exceeds 256 KiB limit", 2);
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  return requireStringOption(options, "text");
}

function buildHandoff(
  session: TerminalSessionStatusResponse,
  projects: TerminalProjectListItem[],
  sessions: TerminalSessionListItem[],
  tailLineCount: number,
  terminalState: TerminalState,
  panels: TerminalPanelWorkspace | null,
): Record<string, unknown> {
  const project = projects.find((item) => item.projectId === session.projectId);
  const listed = sessions.find(
    (item) => item.terminalSessionId === session.terminalSessionId,
  );
  const tail = tailLines(session.scrollback, tailLineCount);
  const workload = inferHandoffWorkloadState(session, tail);
  const stateReasons = [`terminalState=${terminalState.state}`];
  if (terminalState.agent) {
    stateReasons.push(`agent=${terminalState.agent}`);
  }
  if (workload.foregroundCommand) {
    stateReasons.push(`activeCommand=${commandName(workload.foregroundCommand)}`);
  }

  return {
    terminalSessionId: session.terminalSessionId,
    projectId: session.projectId,
    projectName: project?.name ?? null,
    cwd: session.cwd,
    sessionStatus: session.status,
    runtimeKind: session.tmuxSessionName ? "tmux" : "pty",
    tmuxSessionName: session.tmuxSessionName ?? null,
    activeCommand: workload.foregroundCommand ?? listed?.activeCommand ?? null,
    foregroundCommand:
      workload.foregroundCommand ?? listed?.activeCommand ?? null,
    terminalState: terminalState.state,
    agent: terminalState.agent,
    inferredAgent: terminalState.agent ?? "unknown",
    inferredState: terminalState.state,
    inferredWorkloadState: terminalState.state,
    stateConfidence: "strong",
    stateReasons,
    tail,
    panels: panels?.panels ?? [],
    activePanelId: panels?.activePanelId ?? null,
    suggestedCommands: [
      `rw terminal send ${session.terminalSessionId} --text "继续" --enter --confirm short --json`,
      `rw terminal snapshot ${session.terminalSessionId} --tail ${tailLineCount} --plain`,
    ],
    suggestedPanelCommands: (panels?.panels ?? [])
      .filter((panel) => panel.alias || panel.role)
      .map((panel) => {
        const selector = panel.alias ?? panel.role ?? panel.panelId;
        return `rw terminal send ${session.terminalSessionId} --panel ${selector} --text "继续" --enter --json`;
      }),
  };
}
