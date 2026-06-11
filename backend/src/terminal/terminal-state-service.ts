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

export class TerminalStateService {
  constructor(private readonly store: TerminalStateStore) {}

  setShellActiveCommand(
    terminalSessionId: string,
    sessionSnapshot: TerminalStateSessionSnapshot,
  ): TerminalState {
    if (sessionSnapshot.status === "exited" || !isCodexSession(sessionSnapshot)) {
      return this.store.set(terminalSessionId, SHELL_IDLE);
    }

    const stored = this.store.get(terminalSessionId);
    return this.store.set(
      terminalSessionId,
      stored?.agent === "codex" && stored.state !== "shell_idle"
        ? stored
        : CODEX_IDLE,
    );
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

    if (!isCodexSession(sessionSnapshot)) {
      return SHELL_IDLE;
    }

    const stored = this.store.get(terminalSessionId);
    if (stored?.agent === "codex" && stored.state !== "shell_idle") {
      return stored;
    }

    return CODEX_IDLE;
  }
}

export function isCodexSession(
  sessionSnapshot: Pick<TerminalSessionRecord, "activeCommand" | "command">,
): boolean {
  return (
    isCodexActiveCommand(sessionSnapshot.activeCommand) ||
    (sessionSnapshot.activeCommand !== null &&
      isCodexActiveCommand(sessionSnapshot.command))
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
