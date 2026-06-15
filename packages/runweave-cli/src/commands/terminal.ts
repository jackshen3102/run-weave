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
import { tailLines, writeOutput } from "../output/format.js";
import type {
  TerminalProjectListItem,
  TerminalInputMode,
  TerminalSessionListItem,
  TerminalSessionStatusResponse,
  TerminalState,
} from "@runweave/shared";

const DEFAULT_TAIL_LINES = 120;
const DEFAULT_CONFIRM_TIMEOUT_MS = 3000;
const DEFAULT_AGENT_START_TIMEOUT_MS = 15000;
const MAX_STDIN_BYTES = 256 * 1024;
const AGENT_COMMAND_PATTERN =
  /(?:^|\/)(codex|claude|opencode|coco|trae|traecli|traex)(?:$|\s|-)/i;
const SHELL_COMMAND_PATTERN = /(?:^|\/)(zsh|bash|fish|sh)$/i;
const AGENT_PROMPT_PATTERN = /(^|\n)\s*[›>]\s+|\bgpt-[\w.-]+.*[~/]/i;
const SHELL_PROMPT_PATTERN = /(?:^|\n).*(?:[%$#]\s*)$/;
const AGENT_BUSY_PATTERN =
  /(?:working|running|thinking|tool call|updated plan|executing|applying patch|reading|searching|waiting for command|processing)/i;

type HandoffWorkloadState =
  | "idle_shell"
  | "command_running"
  | "agent_running"
  | "agent_waiting_input"
  | "completed"
  | "failed"
  | "unknown";

type StateConfidence = "strong" | "high" | "medium" | "weak" | "low";
type AgentPreparationStatus =
  | "not_requested"
  | "already_ready"
  | "cleared_existing"
  | "started"
  | "restarted";

interface AgentPreparationResult {
  status: AgentPreparationStatus;
  requestedAgent: string | null;
  previousAgent: string | null;
  terminalState: TerminalState | null;
  actions: string[];
}

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

export function inferHandoffWorkloadState(
  session: Pick<
    TerminalSessionStatusResponse,
    "activeCommand" | "command" | "status" | "exitCode"
  >,
  tail: string,
): {
  inferredWorkloadState: HandoffWorkloadState;
  foregroundCommand: string | null;
  stateConfidence: StateConfidence;
  stateReasons: string[];
} {
  const foregroundCommand = session.activeCommand ?? session.command ?? null;
  const command = foregroundCommand ?? "";
  const cleanTail = stripTerminalControlSequences(tail);
  const isAgent = AGENT_COMMAND_PATTERN.test(command);
  const isShell = SHELL_COMMAND_PATTERN.test(command);
  const hasAgentPrompt = AGENT_PROMPT_PATTERN.test(cleanTail);
  const hasShellPrompt = SHELL_PROMPT_PATTERN.test(cleanTail.trimEnd());
  const hasAgentActivity = AGENT_BUSY_PATTERN.test(cleanTail);
  const stateReasons: string[] = [];

  if (foregroundCommand) {
    stateReasons.push(`activeCommand=${commandName(foregroundCommand)}`);
  }

  if (session.status !== "running") {
    stateReasons.push("terminal session is not running");
    return {
      inferredWorkloadState:
        session.exitCode && session.exitCode !== 0 ? "failed" : "completed",
      foregroundCommand,
      stateConfidence: "high",
      stateReasons,
    };
  }

  if (isAgent && hasAgentPrompt) {
    stateReasons.push("tail contains an agent prompt");
    return {
      inferredWorkloadState: "agent_waiting_input",
      foregroundCommand,
      stateConfidence: "medium",
      stateReasons,
    };
  }

  if (isAgent && hasAgentActivity) {
    stateReasons.push("tail contains agent activity markers");
    return {
      inferredWorkloadState: "agent_running",
      foregroundCommand,
      stateConfidence: "medium",
      stateReasons,
    };
  }

  if (isAgent) {
    stateReasons.push("no reliable prompt/running detection available");
    return {
      inferredWorkloadState: "unknown",
      foregroundCommand,
      stateConfidence: "low",
      stateReasons,
    };
  }

  if (isShell && hasShellPrompt) {
    stateReasons.push("tail contains a shell prompt");
    return {
      inferredWorkloadState: "idle_shell",
      foregroundCommand,
      stateConfidence: "medium",
      stateReasons,
    };
  }

  if (foregroundCommand && !isShell) {
    stateReasons.push("foreground command is not a shell");
    return {
      inferredWorkloadState: "command_running",
      foregroundCommand,
      stateConfidence: "low",
      stateReasons,
    };
  }

  stateReasons.push("insufficient signal from foreground command and tail");
  return {
    inferredWorkloadState: "unknown",
    foregroundCommand,
    stateConfidence: "low",
    stateReasons,
  };
}

async function sendWithConfirmation(params: {
  client: TerminalHttpClient;
  terminalSessionId: string;
  text: string;
  enter: boolean;
  inputMode: TerminalInputMode;
  inputModeProvided: boolean;
  confirmMode: string;
  confirmTimeoutMs: number;
  agent: string | undefined;
  agentOverwrite: boolean;
  agentStartCommand: string | undefined;
  agentClearCommand: string;
  agentExitCommand: string | undefined;
  agentStartTimeoutMs: number;
}): Promise<Record<string, unknown>> {
  if (
    !Number.isFinite(params.confirmTimeoutMs) ||
    params.confirmTimeoutMs < 0
  ) {
    throw new CliError("--confirm-timeout-ms must be a non-negative number", 2);
  }
  if (params.confirmMode !== "none" && params.confirmMode !== "short") {
    throw new CliError("--confirm must be one of: none, short", 2);
  }
  const agentPreparation = await prepareAgentSession(params);

  const tailBeforeSession = await params.client.getSession(
    params.terminalSessionId,
  );
  const tailBefore = tailLines(
    tailBeforeSession.scrollback,
    DEFAULT_TAIL_LINES,
  );
  const sendStartedAt = new Date().toISOString();
  const data =
    params.inputMode === "line" ? params.text : `${params.text}${params.enter ? "\r" : ""}`;
  const operationId = buildOperationId();
  const inputPayload = {
    operationId,
    data,
    ...(params.inputModeProvided || params.inputMode !== "raw"
      ? { mode: params.inputMode }
      : {}),
  };
  const inputResult = await params.client.sendInput(
    params.terminalSessionId,
    inputPayload,
  );
  if (params.confirmMode === "short" && params.confirmTimeoutMs > 0) {
    await wait(params.confirmTimeoutMs);
  }
  const tailAfterSession = await params.client.getSession(
    params.terminalSessionId,
  );
  const tailAfter = tailLines(tailAfterSession.scrollback, DEFAULT_TAIL_LINES);
  const echoObserved = containsInputEcho(tailAfter, params.text);
  const observedState = inferState(tailAfterSession, tailAfter);
  const promptChanged =
    tailBeforeSession.activeCommand !== tailAfterSession.activeCommand ||
    tailBeforeSession.status !== tailAfterSession.status;
  const confirmConfidence = resolveConfirmConfidence({
    echoObserved,
    observedState,
    promptChanged,
    inputAccepted: inputResult.inputAccepted,
  });

  return {
    operationId: inputResult.operationId,
    terminalSessionId: params.terminalSessionId,
    transport: "http",
    inputAccepted: inputResult.inputAccepted,
    inputEnqueued: inputResult.inputEnqueued,
    runtimeKind: inputResult.runtimeKind,
    acceptedAt: inputResult.acceptedAt,
    submitted:
      params.inputMode === "line" ||
      params.enter ||
      /[\r\n]$/.test(params.text),
    confirmMode: params.confirmMode,
    confirmTimeoutMs:
      params.confirmMode === "short" ? params.confirmTimeoutMs : 0,
    echoObserved,
    promptChanged,
    observedState,
    confirmConfidence,
    tailBefore,
    tailAfter,
    sendStartedAt,
    hook: {
      completionExpected: true,
      expectedSource: inferAgent(tailAfterSession.activeCommand, tailAfter),
      notificationOwner: "existing-ai-cli-hooks",
    },
    agentPreparation,
    note: "Completion will be delivered by configured AI CLI hook if available.",
  };
}

async function prepareAgentSession(params: {
  client: TerminalHttpClient;
  terminalSessionId: string;
  agent: string | undefined;
  agentOverwrite: boolean;
  agentStartCommand: string | undefined;
  agentClearCommand: string;
  agentExitCommand: string | undefined;
  agentStartTimeoutMs: number;
}): Promise<AgentPreparationResult> {
  if (!params.agent) {
    if (params.agentOverwrite) {
      throw new CliError("--agent-overwrite requires --agent", 2);
    }
    return {
      status: "not_requested",
      requestedAgent: null,
      previousAgent: null,
      terminalState: null,
      actions: [],
    };
  }
  if (!isValidAgentName(params.agent)) {
    throw new CliError("--agent must contain only letters, numbers, '.', '_' or '-'", 2);
  }
  if (
    !Number.isFinite(params.agentStartTimeoutMs) ||
    params.agentStartTimeoutMs < 0
  ) {
    throw new CliError("--agent-start-timeout-ms must be a non-negative number", 2);
  }

  const actions: string[] = [];
  const initial = await getAgentSessionSnapshot(params);
  if (initial.session.status !== "running") {
    throw new CliError("Terminal session is not running", 4);
  }

  const initialAgent = resolveCurrentAgent(initial);
  if (isRequestedAgentReady(initial, params.agent)) {
    if (!params.agentOverwrite) {
      return {
        status: "already_ready",
        requestedAgent: params.agent,
        previousAgent: initialAgent,
        terminalState: initial.terminalState,
        actions,
      };
    }
    await sendAgentControlLine(params, params.agentClearCommand);
    actions.push("clear");
    const terminalState = await waitForRequestedAgent(params, params.agent);
    return {
      status: "cleared_existing",
      requestedAgent: params.agent,
      previousAgent: initialAgent,
      terminalState,
      actions,
    };
  }

  if (initialAgent && !params.agentOverwrite) {
    throw new CliError(
      `Terminal is already using agent "${initialAgent}". Pass --agent-overwrite to replace it with "${params.agent}".`,
      2,
    );
  }

  if (initialAgent) {
    await sendAgentControlLine(
      params,
      params.agentExitCommand ?? getDefaultAgentExitCommand(initialAgent),
    );
    actions.push("exit_existing");
    await waitForNoAgent(params);
  }

  await sendAgentControlLine(params, params.agentStartCommand ?? params.agent);
  actions.push("start");
  const terminalState = await waitForRequestedAgent(params, params.agent);
  return {
    status: initialAgent ? "restarted" : "started",
    requestedAgent: params.agent,
    previousAgent: initialAgent,
    terminalState,
    actions,
  };
}

async function getAgentSessionSnapshot(params: {
  client: TerminalHttpClient;
  terminalSessionId: string;
}): Promise<{
  session: TerminalSessionStatusResponse;
  terminalState: TerminalState;
}> {
  const [session, statePayload] = await Promise.all([
    params.client.getSession(params.terminalSessionId),
    params.client.getCurrentTerminalState(params.terminalSessionId),
  ]);
  return {
    session,
    terminalState: statePayload.terminalState,
  };
}

function resolveCurrentAgent(snapshot: {
  session: Pick<TerminalSessionStatusResponse, "activeCommand">;
  terminalState: TerminalState;
}): string | null {
  return (
    (snapshot.terminalState.state !== "shell_idle"
      ? snapshot.terminalState.agent
      : null) ?? commandNameOrNull(snapshot.session.activeCommand)
  );
}

function isRequestedAgentReady(
  snapshot: {
    session: Pick<TerminalSessionStatusResponse, "activeCommand">;
    terminalState: TerminalState;
  },
  agent: string,
): boolean {
  return (
    snapshot.terminalState.state !== "shell_idle" &&
    resolveCurrentAgent(snapshot) === agent
  );
}

async function sendAgentControlLine(
  params: {
    client: TerminalHttpClient;
    terminalSessionId: string;
  },
  command: string,
): Promise<void> {
  await params.client.sendInput(params.terminalSessionId, {
    operationId: buildOperationId(),
    data: command,
    mode: "line",
  });
}

async function waitForRequestedAgent(
  params: {
    client: TerminalHttpClient;
    terminalSessionId: string;
    agentStartTimeoutMs: number;
  },
  agent: string,
): Promise<TerminalState> {
  const snapshot = await waitForAgentCondition(params, (next) =>
    isRequestedAgentReady(next, agent),
  );
  return snapshot.terminalState;
}

async function waitForNoAgent(params: {
  client: TerminalHttpClient;
  terminalSessionId: string;
  agentStartTimeoutMs: number;
}): Promise<void> {
  await waitForAgentCondition(params, (next) => resolveCurrentAgent(next) === null);
}

async function waitForAgentCondition(
  params: {
    client: TerminalHttpClient;
    terminalSessionId: string;
    agentStartTimeoutMs: number;
  },
  predicate: (snapshot: {
    session: TerminalSessionStatusResponse;
    terminalState: TerminalState;
  }) => boolean,
): Promise<{
  session: TerminalSessionStatusResponse;
  terminalState: TerminalState;
}> {
  const startedAt = Date.now();
  let lastSnapshot = await getAgentSessionSnapshot(params);
  while (Date.now() - startedAt <= params.agentStartTimeoutMs) {
    if (predicate(lastSnapshot)) {
      return lastSnapshot;
    }
    await wait(500);
    lastSnapshot = await getAgentSessionSnapshot(params);
  }
  throw new CliError(
    `Timed out waiting for terminal agent state. Last state=${lastSnapshot.terminalState.state}, agent=${lastSnapshot.terminalState.agent ?? "none"}, activeCommand=${lastSnapshot.session.activeCommand ?? "none"}`,
    3,
  );
}

function isValidAgentName(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function getDefaultAgentExitCommand(agent: string): string {
  if (agent === "codex" || agent === "traex" || agent === "traecli") {
    return "/quit";
  }
  return "/exit";
}

function commandNameOrNull(command: string | null): string | null {
  if (!command) {
    return null;
  }
  return commandName(command);
}

function containsInputEcho(tail: string, text: string): boolean {
  const cleaned = text.replace(/[\r\n]+$/g, "").trim();
  if (!cleaned) {
    return false;
  }
  return tail.includes(cleaned) || tail.includes(cleaned.slice(0, 32));
}

function inferAgent(activeCommand: string | null, tail: string): string {
  const command = commandNameOrNull(activeCommand);
  if (command) {
    return command;
  }
  const source = tail.toLowerCase();
  if (source.includes("claude")) {
    return "claude";
  }
  if (source.includes("traecli")) {
    return "traecli";
  }
  if (source.includes("traex")) {
    return "traex";
  }
  if (source.includes("coco")) {
    return "coco";
  }
  if (source.includes("codex")) {
    return "codex";
  }
  if (source.includes("trae")) {
    return "trae";
  }
  return "unknown";
}

function stripTerminalControlSequences(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const charCode = value.charCodeAt(index);
    if (charCode !== 27) {
      result += value[index];
      continue;
    }

    const next = value[index + 1];
    if (next === "[") {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code >= 64 && code <= 126) {
          break;
        }
        index += 1;
      }
      continue;
    }

    if (next === "]") {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code === 7) {
          break;
        }
        if (code === 27 && value[index + 1] === "\\") {
          index += 1;
          break;
        }
        index += 1;
      }
    }
  }

  return result;
}

function commandName(command: string): string {
  return (
    command
      .trim()
      .split(/[/\s]+/)
      .filter(Boolean)
      .at(-1) ?? command
  );
}

function inferState(
  session: TerminalSessionStatusResponse,
  tail: string,
): "agent_running" | "idle_shell" | "unknown" {
  if (session.activeCommand && !isShellCommand(session.activeCommand)) {
    return "agent_running";
  }
  if (/\b(working|running|thinking|processing)\b/i.test(tail)) {
    return "agent_running";
  }
  if (session.status === "running" && !session.activeCommand) {
    return "idle_shell";
  }
  return "unknown";
}

function isShellCommand(command: string): boolean {
  return ["bash", "zsh", "sh", "fish"].includes(command);
}

function resolveConfirmConfidence(params: {
  echoObserved: boolean;
  observedState: string;
  promptChanged: boolean;
  inputAccepted: boolean;
}): "high" | "medium" | "low" {
  if (!params.inputAccepted) {
    return "low";
  }
  if (params.echoObserved || params.observedState === "agent_running") {
    return "high";
  }
  if (params.promptChanged) {
    return "medium";
  }
  return "low";
}

function buildOperationId(): string {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const random = Math.random().toString(16).slice(2, 10);
  return `op_${timestamp}_${random}`;
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
