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
  TerminalSessionListItem,
  TerminalSessionStatusResponse,
} from "@browser-viewer/shared";

const DEFAULT_TAIL_LINES = 120;
const DEFAULT_CONFIRM_TIMEOUT_MS = 3000;
const MAX_STDIN_BYTES = 256 * 1024;
const AGENT_COMMAND_PATTERN = /(?:^|\/)(codex|claude|opencode|coco)(?:$|\s|-)/i;
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

type StateConfidence = "high" | "medium" | "low";

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
      "Usage: rw terminal <create|list|show|snapshot|handoff|send>",
      2,
    );
  }

  const parsed = parseArgs(args, new Set(["json", "plain", "enter", "stdin"]));
  const mode = resolveOutputMode(parsed.options);
  const auth = await resolveAuthContext({
    profileName: getStringOption(parsed.options, "profile"),
    env: io.env,
  });
  const client = new TerminalHttpClient(auth);

  if (subcommand === "create") {
    const payload = await client.createSession({
      projectId: requireStringOption(parsed.options, "project-id"),
      cwd: requireStringOption(parsed.options, "cwd"),
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
    const [projects, sessions, session] = await Promise.all([
      client.listProjects(),
      client.listSessions(),
      client.getSession(terminalSessionId),
    ]);
    writeOutput(
      io.stdout,
      mode,
      buildHandoff(session, projects, sessions, resolveTail(parsed.options)),
    );
    return;
  }

  if (subcommand === "send") {
    const terminalSessionId = requireTerminalId(parsed.positionals);
      const result = await sendWithConfirmation({
        client,
        terminalSessionId,
        text: await resolveInputText(parsed.options, io.stdin),
        enter: getBooleanOption(parsed.options, "enter"),
      confirmMode: getStringOption(parsed.options, "confirm") ?? "none",
      confirmTimeoutMs: Number(
        getStringOption(parsed.options, "confirm-timeout-ms") ??
          DEFAULT_CONFIRM_TIMEOUT_MS,
      ),
    });
    writeOutput(io.stdout, mode, result);
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
): Record<string, unknown> {
  const project = projects.find((item) => item.projectId === session.projectId);
  const listed = sessions.find(
    (item) => item.terminalSessionId === session.terminalSessionId,
  );
  const tail = tailLines(session.scrollback, tailLineCount);
  const inferredAgent = inferAgent(session.activeCommand, tail);
  const workload = inferHandoffWorkloadState(session, tail);

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
    inferredAgent,
    inferredState: workload.inferredWorkloadState,
    inferredWorkloadState: workload.inferredWorkloadState,
    stateConfidence: workload.stateConfidence,
    stateReasons: workload.stateReasons,
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
  confirmMode: string;
  confirmTimeoutMs: number;
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

  const tailBeforeSession = await params.client.getSession(
    params.terminalSessionId,
  );
  const tailBefore = tailLines(
    tailBeforeSession.scrollback,
    DEFAULT_TAIL_LINES,
  );
  const sendStartedAt = new Date().toISOString();
  const data = `${params.text}${params.enter ? "\r" : ""}`;
  const operationId = buildOperationId();
  const inputResult = await params.client.sendInput(params.terminalSessionId, {
    operationId,
    data,
  });
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
    submitted: params.enter || /[\r\n]$/.test(params.text),
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
    note: "Completion will be delivered by configured AI CLI hook if available.",
  };
}

function containsInputEcho(tail: string, text: string): boolean {
  const cleaned = text.replace(/[\r\n]+$/g, "").trim();
  if (!cleaned) {
    return false;
  }
  return tail.includes(cleaned) || tail.includes(cleaned.slice(0, 32));
}

function inferAgent(activeCommand: string | null, tail: string): string {
  const source = `${activeCommand ?? ""}\n${tail}`.toLowerCase();
  if (source.includes("codex")) {
    return "codex";
  }
  if (source.includes("claude")) {
    return "claude";
  }
  if (source.includes("trae")) {
    return "trae";
  }
  if (source.includes("coco")) {
    return "coco";
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
