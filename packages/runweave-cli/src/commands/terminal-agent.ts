import type { TerminalHttpClient } from "../client/terminal-http-client.js";
import { CliError } from "../errors.js";
import { tailLines } from "../output/format.js";
import type {
  TerminalInputMode,
  TerminalSessionStatusResponse,
  TerminalState,
} from "@runweave/shared";

const DEFAULT_TAIL_LINES = 120;
export const DEFAULT_CONFIRM_TIMEOUT_MS = 3000;
export const DEFAULT_AGENT_START_TIMEOUT_MS = 15000;
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

export async function sendWithConfirmation(params: {
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

export function commandName(command: string): string {
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

export function buildOperationId(): string {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const random = Math.random().toString(16).slice(2, 10);
  return `op_${timestamp}_${random}`;
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
