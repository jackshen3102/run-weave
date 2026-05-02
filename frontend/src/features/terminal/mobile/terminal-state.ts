export type InferredWorkloadState =
  | "idle_shell"
  | "command_running"
  | "agent_running"
  | "agent_waiting_input"
  | "completed"
  | "failed"
  | "history_unavailable"
  | "possibly_stuck"
  | "unknown";

export type StatusColor = "green" | "blue" | "yellow" | "red" | "gray";

export interface TerminalStateInput {
  sessionStatus: "running" | "exited" | "stopped";
  exitCode?: number;
  activeCommand?: string | null;
  command?: string | null;
  tail: string;
  tailChangedRecently: boolean;
}

export interface TerminalStateInference {
  inferredWorkloadState: InferredWorkloadState;
  foregroundCommand: string | null;
  statusLabel: string;
  statusColor: StatusColor;
  confidence: number;
  stateReason: string[];
  primaryAction: "send_to_hermes" | "observe" | "run_command" | "summarize";
}

const AGENT_COMMAND_PATTERN = /(?:^|\/)(codex|claude|opencode|coco)(?:$|\s|-)/i;
const SHELL_COMMAND_PATTERN = /(?:^|\/)(zsh|bash|fish|sh)$/i;
const AGENT_PROMPT_PATTERN = /(^|\n)\s*[›>]\s+|\bgpt-[\w.-]+.*[~/]/i;
const SHELL_PROMPT_PATTERN = /(?:^|\n).*(?:[%$#]\s*)$/;
const AGENT_BUSY_PATTERN =
  /(?:running|thinking|tool call|updated plan|executing|applying patch|reading|searching|waiting for command)/i;
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
      continue;
    }
  }

  return result;
}

function commandName(command: string | null): string | null {
  if (!command) {
    return null;
  }

  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }

  return (
    trimmed
      .split(/[/\s]+/)
      .filter(Boolean)
      .at(-1) ?? trimmed
  );
}

function toLabel(
  foregroundCommand: string | null,
  state: InferredWorkloadState,
): string {
  const command = commandName(foregroundCommand);
  if (state === "agent_waiting_input") {
    return `${command ?? "Agent"} · 等待输入`;
  }
  if (state === "agent_running") {
    return `${command ?? "Agent"} · 正在执行`;
  }
  if (state === "idle_shell") {
    return `${command ?? "shell"} · 空闲`;
  }
  if (state === "command_running") {
    return `${command ?? "命令"} · 执行中`;
  }
  if (state === "possibly_stuck") {
    return `${command ?? "终端"} · 可能卡住`;
  }
  if (state === "failed") {
    return "已结束 · 失败";
  }
  if (state === "history_unavailable") {
    return "状态不可用";
  }
  if (state === "completed") {
    return "已结束";
  }
  return `${command ?? "终端"} · 未知`;
}

function colorForState(state: InferredWorkloadState): StatusColor {
  if (state === "agent_waiting_input") {
    return "yellow";
  }
  if (state === "agent_running" || state === "command_running") {
    return "blue";
  }
  if (state === "idle_shell" || state === "completed") {
    return "green";
  }
  if (state === "possibly_stuck" || state === "failed") {
    return "red";
  }
  return "gray";
}

function primaryActionForState(
  state: InferredWorkloadState,
): TerminalStateInference["primaryAction"] {
  if (state === "agent_waiting_input" || state === "possibly_stuck") {
    return "send_to_hermes";
  }
  if (state === "idle_shell") {
    return "run_command";
  }
  if (state === "completed" || state === "failed") {
    return "summarize";
  }
  return "observe";
}

export function inferTerminalState(
  input: TerminalStateInput,
): TerminalStateInference {
  const foregroundCommand = input.activeCommand ?? input.command ?? null;
  const command = foregroundCommand ?? "";
  const tail = stripTerminalControlSequences(input.tail ?? "");
  const isAgent = AGENT_COMMAND_PATTERN.test(command);
  const isShell = SHELL_COMMAND_PATTERN.test(command);
  const hasAgentPrompt = AGENT_PROMPT_PATTERN.test(tail);
  const hasShellPrompt = SHELL_PROMPT_PATTERN.test(tail.trimEnd());
  const hasAgentActivity = AGENT_BUSY_PATTERN.test(tail);
  const stateReason: string[] = [];
  let inferredWorkloadState: InferredWorkloadState = "unknown";
  let confidence = 0.45;

  if (foregroundCommand) {
    stateReason.push(
      `前台程序是 ${commandName(foregroundCommand) ?? foregroundCommand}`,
    );
  }

  if (input.sessionStatus !== "running") {
    inferredWorkloadState =
      input.exitCode && input.exitCode !== 0 ? "failed" : "completed";
    confidence = 0.9;
    stateReason.push("终端 session 已结束");
  } else if (isAgent && hasAgentPrompt && !input.tailChangedRecently) {
    inferredWorkloadState = "agent_waiting_input";
    confidence = 0.82;
    stateReason.push("tail 末尾检测到 Agent prompt");
    stateReason.push("最近一次刷新没有新增输出");
  } else if (isAgent && (input.tailChangedRecently || hasAgentActivity)) {
    inferredWorkloadState = "agent_running";
    confidence = input.tailChangedRecently ? 0.78 : 0.66;
    stateReason.push(
      input.tailChangedRecently
        ? "最近 tail 有新增输出"
        : "tail 中检测到执行中迹象",
    );
  } else if (isShell && hasShellPrompt) {
    inferredWorkloadState = "idle_shell";
    confidence = 0.76;
    stateReason.push("检测到 shell prompt");
  } else if (isShell && !input.tailChangedRecently) {
    inferredWorkloadState = "idle_shell";
    confidence = 0.64;
    stateReason.push("shell 在前台且最近一次刷新没有新增输出");
  } else if (!isShell && !isAgent && input.tailChangedRecently) {
    inferredWorkloadState = "command_running";
    confidence = 0.7;
    stateReason.push("非 shell/agent 前台程序最近仍有输出");
  } else if (isAgent) {
    inferredWorkloadState = "possibly_stuck";
    confidence = 0.58;
    stateReason.push("Agent 在前台但未检测到 prompt 或新增输出");
  } else if (foregroundCommand && !isShell) {
    inferredWorkloadState = "command_running";
    confidence = 0.56;
    stateReason.push("前台程序不是 shell，按执行中处理");
  } else {
    stateReason.push("现有信号不足，需查看 tail 确认");
  }

  return {
    inferredWorkloadState,
    foregroundCommand,
    statusLabel: toLabel(foregroundCommand, inferredWorkloadState),
    statusColor: colorForState(inferredWorkloadState),
    confidence,
    stateReason,
    primaryAction: primaryActionForState(inferredWorkloadState),
  };
}
