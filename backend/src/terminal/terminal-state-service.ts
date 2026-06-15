import type {
  AgentHookStateEvent,
  TerminalAgentKind,
  TerminalState,
  TerminalStateChangeReason,
} from "@runweave/shared";
import type { TerminalSessionRecord } from "./manager";
import type { TerminalEventService } from "./terminal-event-service";
import type { TerminalStateStore } from "./terminal-state-store";

type TerminalStateSessionSnapshot = Pick<
  TerminalSessionRecord,
  "activeCommand" | "command" | "status" | "terminalState"
>;

const SHELL_IDLE: TerminalState = { state: "shell_idle", agent: null };
const AGENT_COMMANDS: Record<TerminalAgentKind, ReadonlySet<string>> = {
  codex: new Set(["codex"]),
  trae: new Set(["trae"]),
  traecli: new Set(["traecli"]),
  traex: new Set(["traex"]),
};

interface TerminalStatePublishContext {
  projectId: string | null;
  reason: TerminalStateChangeReason;
}

export class TerminalStateService {
  constructor(
    private readonly store: TerminalStateStore,
    private readonly eventService?: TerminalEventService,
    private readonly onStateChange?: (
      terminalSessionId: string,
      state: TerminalState,
    ) => void,
  ) {}

  setShellActiveCommand(
    terminalSessionId: string,
    sessionSnapshot: TerminalStateSessionSnapshot,
    context?: TerminalStatePublishContext,
  ): TerminalState {
    const agent = getTerminalSessionAgent(sessionSnapshot);
    if (sessionSnapshot.status === "exited" || !agent) {
      return this.setAndPublish(terminalSessionId, SHELL_IDLE, context);
    }

    const stored = this.store.get(terminalSessionId);
    const persisted = sessionSnapshot.terminalState;
    return this.setAndPublish(
      terminalSessionId,
      resolveStoredAgentState(stored, agent) ??
        resolveStoredAgentState(persisted, agent) ??
        createAgentState(agent, "agent_idle"),
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

    if (hookEvent === "UserPromptSubmit") {
      return this.setAndPublish(
        terminalSessionId,
        createAgentState(agent, "agent_running"),
        publishContext,
      );
    }

    return this.setAndPublish(
      terminalSessionId,
      createAgentState(agent, "agent_idle"),
      publishContext,
    );
  }

  getCurrent(
    terminalSessionId: string,
    sessionSnapshot: TerminalStateSessionSnapshot | undefined,
  ): TerminalState {
    if (!sessionSnapshot || sessionSnapshot.status === "exited") {
      return SHELL_IDLE;
    }

    const agent = getTerminalSessionAgent(sessionSnapshot);
    if (!agent) {
      return SHELL_IDLE;
    }

    const stored = this.store.get(terminalSessionId);
    const agentState =
      resolveStoredAgentState(stored, agent) ??
      resolveStoredAgentState(sessionSnapshot.terminalState, agent);
    if (agentState) {
      return agentState;
    }

    return createAgentState(agent, "agent_idle");
  }

  private setAndPublish(
    terminalSessionId: string,
    next: TerminalState,
    context: TerminalStatePublishContext | undefined,
  ): TerminalState {
    const previous = this.store.get(terminalSessionId) ?? SHELL_IDLE;
    const saved = this.store.set(terminalSessionId, next);
    if (previous.state !== next.state || previous.agent !== next.agent) {
      this.onStateChange?.(terminalSessionId, next);
    }
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

function resolveStoredAgentState(
  state: TerminalState | null | undefined,
  agent: TerminalAgentKind,
): TerminalState | null {
  return state?.agent === agent && state.state !== "shell_idle"
    ? state
    : null;
}

export function isCodexSession(
  sessionSnapshot: Pick<TerminalSessionRecord, "activeCommand" | "command">,
): boolean {
  return getTerminalSessionAgent(sessionSnapshot) === "codex";
}

export function isCodexActiveCommand(activeCommand: string | null): boolean {
  return getAgentForCommand(activeCommand) === "codex";
}

export function getTerminalSessionAgent(
  sessionSnapshot: Pick<TerminalSessionRecord, "activeCommand" | "command">,
): TerminalAgentKind | null {
  return (
    getAgentForCommand(sessionSnapshot.activeCommand) ??
    (sessionSnapshot.activeCommand !== null
      ? getAgentForCommand(sessionSnapshot.command)
      : null)
  );
}

export function getAgentForCommand(
  activeCommand: string | null,
): TerminalAgentKind | null {
  if (!activeCommand) {
    return null;
  }
  const normalized = activeCommand.trim().replace(/\\+/g, "/");
  const basename = normalized.split("/").filter(Boolean).at(-1) ?? normalized;
  for (const [agent, commands] of Object.entries(AGENT_COMMANDS)) {
    if (commands.has(basename)) {
      return agent as TerminalAgentKind;
    }
  }
  return null;
}

function createAgentState(
  agent: TerminalAgentKind,
  state: "agent_idle" | "agent_running",
): TerminalState {
  return { state, agent };
}
