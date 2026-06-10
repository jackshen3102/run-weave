import type {
  AgentHookStateEvent,
  TerminalAgentKind,
  TerminalState,
} from "@browser-viewer/shared";
import type { TerminalSessionRecord } from "./manager";
import type { TerminalStateStore } from "./terminal-state-store";

type TerminalStateSessionSnapshot = Pick<
  TerminalSessionRecord,
  "activeCommand" | "command" | "status"
>;

const SHELL_IDLE: TerminalState = { state: "shell_idle", agent: null };
const CODEX_IDLE: TerminalState = { state: "agent_idle", agent: "codex" };
const CODEX_RUNNING: TerminalState = {
  state: "agent_running",
  agent: "codex",
};
const CODEX_WORKING_PATTERN =
  /(?:^|\n)\s*(?:[•●]\s*)?Working\s*\([^)]*esc to interrupt[^)]*\)/i;

export class TerminalStateService {
  constructor(private readonly store: TerminalStateStore) {}

  setShellActiveCommand(
    terminalSessionId: string,
    sessionSnapshot: TerminalStateSessionSnapshot,
  ): TerminalState {
    if (sessionSnapshot.status === "exited") {
      return this.store.set(terminalSessionId, SHELL_IDLE);
    }

    if (isCodexSession(sessionSnapshot)) {
      const stored = this.store.get(terminalSessionId);
      return this.store.set(
        terminalSessionId,
        stored?.agent === "codex" && stored.state !== "shell_idle"
          ? stored
          : CODEX_IDLE,
      );
    }

    const nextState = isCodexActiveCommand(sessionSnapshot.activeCommand)
      ? CODEX_IDLE
      : SHELL_IDLE;
    return this.store.set(terminalSessionId, nextState);
  }

  handleAgentHook(
    terminalSessionId: string,
    agent: TerminalAgentKind,
    hookEvent: AgentHookStateEvent,
  ): TerminalState {
    if (agent !== "codex") {
      return this.store.set(terminalSessionId, SHELL_IDLE);
    }

    if (hookEvent === "UserPromptSubmit") {
      return this.store.set(terminalSessionId, CODEX_RUNNING);
    }

    return this.store.set(terminalSessionId, CODEX_IDLE);
  }

  getCurrent(
    terminalSessionId: string,
    sessionSnapshot: TerminalStateSessionSnapshot | undefined,
  ): TerminalState {
    if (!sessionSnapshot || sessionSnapshot.status === "exited") {
      return SHELL_IDLE;
    }

    const stored = this.store.get(terminalSessionId);
    if (stored?.agent === "codex" && stored.state !== "shell_idle") {
      return stored;
    }

    return isCodexSession(sessionSnapshot)
      ? CODEX_IDLE
      : SHELL_IDLE;
  }

  reconcileCurrentFromOutput(
    terminalSessionId: string,
    sessionSnapshot: TerminalStateSessionSnapshot | undefined,
    output: string,
  ): TerminalState {
    const current = this.getCurrent(terminalSessionId, sessionSnapshot);
    if (
      current.state === "agent_idle" &&
      sessionSnapshot &&
      isCodexSession(sessionSnapshot) &&
      isCodexWorkingOutput(output)
    ) {
      return this.store.set(terminalSessionId, CODEX_RUNNING);
    }

    return current;
  }
}

export function isCodexSession(
  sessionSnapshot: Pick<TerminalSessionRecord, "activeCommand" | "command">,
): boolean {
  return (
    isCodexActiveCommand(sessionSnapshot.activeCommand) ||
    isCodexActiveCommand(sessionSnapshot.command)
  );
}

export function isCodexActiveCommand(activeCommand: string | null): boolean {
  if (!activeCommand) {
    return false;
  }
  const normalized = activeCommand.trim().replace(/\\+/g, "/");
  const basename = normalized.split("/").filter(Boolean).at(-1) ?? normalized;
  return basename === "codex";
}

export function isCodexWorkingOutput(output: string): boolean {
  return CODEX_WORKING_PATTERN.test(output);
}
