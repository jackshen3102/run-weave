export type TerminalAgentKind = "codex" | "trae" | "traex" | "traecli";

export type TerminalStateValue =
  | "shell_idle"
  | "agent_starting"
  | "agent_idle"
  | "agent_running";

export interface TerminalState {
  state: TerminalStateValue;
  agent: TerminalAgentKind | null;
}

export type TerminalStateChangeReason =
  | "agent_hook"
  | "metadata"
  | "interrupt"
  | "exit";
