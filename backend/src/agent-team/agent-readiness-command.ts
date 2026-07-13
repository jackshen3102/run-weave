import type { AgentTeamTerminal } from "@runweave/shared/agent-team";
import type { TerminalAgentKind } from "@runweave/shared/terminal/state";

const CODEX_SKIP_UPDATE_ON_STARTUP_ARGS = [
  "-c",
  "check_for_update_on_startup=false",
] as const;

export function buildAgentStartCommand(
  terminal: AgentTeamTerminal,
  agent: TerminalAgentKind,
): string {
  const command = terminal.command?.trim() || agent;
  const args =
    agent === "codex"
      ? withCodexSkipUpdateOnStartupArgs(terminal.args ?? [])
      : (terminal.args ?? []);
  if (args.length === 0) {
    return command;
  }
  return [command, ...args.map(shellQuote)].join(" ");
}

function withCodexSkipUpdateOnStartupArgs(
  args: readonly string[],
): readonly string[] {
  if (args.some((arg) => arg.includes("check_for_update_on_startup"))) {
    return args;
  }
  return [...CODEX_SKIP_UPDATE_ON_STARTUP_ARGS, ...args];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function waitForAgentReadinessPoll(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
