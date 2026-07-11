import type { TerminalSessionStatusResponse } from "@runweave/shared/terminal/session";

const AGENT_COMMAND_PATTERN =
  /(?:^|\/)(codex|claude|opencode|coco|trae|traecli|traex)(?:$|\s|-)/i;
const SHELL_COMMAND_PATTERN = /(?:^|\/)(zsh|bash|fish|sh)$/i;
export const AGENT_PROMPT_PATTERN = /(^|\n)\s*[›>]\s+|\bgpt-[\w.-]+.*[~/]/i;
const SHELL_PROMPT_PATTERN = /(?:^|\n).*(?:[%$#]\s*)$/;
const AGENT_BUSY_PATTERN =
  /(?:working|running|thinking|tool call|updated plan|executing|applying patch|reading|searching|waiting for command|processing)/i;

export type HandoffWorkloadState =
  | "idle_shell"
  | "command_running"
  | "agent_running"
  | "agent_waiting_input"
  | "completed"
  | "failed"
  | "unknown";

export type StateConfidence = "strong" | "high" | "medium" | "weak" | "low";

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

export function commandNameOrNull(command: string | null): string | null {
  if (!command) {
    return null;
  }
  return commandName(command);
}

export function agentNameOrNull(command: string | null): string | null {
  const name = commandNameOrNull(command);
  if (!name || !isKnownAgentName(name)) {
    return null;
  }
  return name;
}

export function isKnownAgentName(value: string): boolean {
  return /^(codex|claude|opencode|coco|trae|traecli|traex)$/i.test(value);
}

export function containsInputEcho(tail: string, text: string): boolean {
  const cleaned = text.replace(/[\r\n]+$/g, "").trim();
  if (!cleaned) {
    return false;
  }
  return tail.includes(cleaned) || tail.includes(cleaned.slice(0, 32));
}

export function inferAgent(activeCommand: string | null, tail: string): string {
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

export function stripTerminalControlSequences(value: string): string {
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

export function inferState(
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

export function isShellCommand(command: string): boolean {
  return ["bash", "zsh", "sh", "fish"].includes(command);
}

export function resolveConfirmConfidence(params: {
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

export async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
