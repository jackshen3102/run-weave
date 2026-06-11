import type {
  AgentHookStateEvent,
  TerminalAgentKind,
  TerminalState,
  TerminalStateChangeReason,
} from "@browser-viewer/shared";
import type { TerminalSessionRecord } from "./manager";
import type { TerminalEventService } from "./terminal-event-service";
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

interface TerminalStatePublishContext {
  projectId: string | null;
  reason: TerminalStateChangeReason;
}

export class TerminalStateService {
  constructor(
    private readonly store: TerminalStateStore,
    private readonly eventService?: TerminalEventService,
  ) {}

  setShellActiveCommand(
    terminalSessionId: string,
    sessionSnapshot: TerminalStateSessionSnapshot,
    context?: TerminalStatePublishContext,
  ): TerminalState {
    if (sessionSnapshot.status === "exited" || !isCodexSession(sessionSnapshot)) {
      return this.setAndPublish(terminalSessionId, SHELL_IDLE, context);
    }

    const stored = this.store.get(terminalSessionId);
    return this.setAndPublish(
      terminalSessionId,
      stored?.agent === "codex" && stored.state !== "shell_idle"
        ? stored
        : CODEX_IDLE,
      context,
    );
  }

  handleAgentHook(
    terminalSessionId: string,
    agent: TerminalAgentKind,
    hookEvent: AgentHookStateEvent,
    context?: Partial<TerminalStatePublishContext>,
  ): TerminalState {
    const publishContext = context
      ? {
          projectId: context.projectId ?? null,
          reason: context.reason ?? "agent_hook",
        }
      : undefined;

    if (agent !== "codex") {
      return this.setAndPublish(terminalSessionId, SHELL_IDLE, publishContext);
    }

    if (hookEvent === "UserPromptSubmit") {
      return this.setAndPublish(
        terminalSessionId,
        CODEX_RUNNING,
        publishContext,
      );
    }

    return this.setAndPublish(terminalSessionId, CODEX_IDLE, publishContext);
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

  private setAndPublish(
    terminalSessionId: string,
    next: TerminalState,
    context: TerminalStatePublishContext | undefined,
  ): TerminalState {
    const previous = this.store.get(terminalSessionId) ?? SHELL_IDLE;
    const saved = this.store.set(terminalSessionId, next);
    if (
      context &&
      (previous.state !== next.state || previous.agent !== next.agent)
    ) {
      this.eventService?.record({
        kind: "terminal_state_changed",
        terminalSessionId,
        projectId: context.projectId,
        payload: {
          previous,
          next,
          reason: context.reason,
        },
      });
    }
    return saved;
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
