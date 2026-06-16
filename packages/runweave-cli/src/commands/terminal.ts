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
import type {
  TerminalProjectListItem,
  TerminalInputMode,
  TerminalSessionListItem,
  TerminalSessionStatusResponse,
  TerminalState,
} from "@runweave/shared";

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
      "Usage: rw terminal <create|list|show|snapshot|handoff|send|interrupt|state|history|delete>",
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
    const session = await client.getSession(terminalSessionId);
    const tail = tailLines(session.scrollback, resolveTail(parsed.options));
    writeOutput(io.stdout, mode, mode === "json" ? { ...session, tail } : tail);
    return;
  }

  if (subcommand === "handoff") {
    const terminalSessionId = requireTerminalId(parsed.positionals);
    const [projects, sessions, session, statePayload] = await Promise.all([
      client.listProjects(),
      client.listSessions(),
      client.getSession(terminalSessionId),
      client.getCurrentTerminalState(terminalSessionId),
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
    const session = await client.getSessionHistory(terminalSessionId);
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
  if (value === "raw" || value === "line" || value === "codex_slash_command") {
    return value;
  }
  throw new CliError("--mode must be one of: raw, line, codex_slash_command", 2);
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
    suggestedCommands: [
      `rw terminal send ${session.terminalSessionId} --text "继续" --enter --confirm short --json`,
      `rw terminal snapshot ${session.terminalSessionId} --tail ${tailLineCount} --plain`,
    ],
  };
}
