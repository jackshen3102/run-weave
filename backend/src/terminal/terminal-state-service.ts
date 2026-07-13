import type { AgentHookStateEvent } from "@runweave/shared/terminal/events";
import type { TerminalAgentKind, TerminalState, TerminalStateChangeReason } from "@runweave/shared/terminal/state";
import {
  hasCodexReadyPrompt,
  hasTraeReadyPrompt,
} from "@runweave/shared/terminal-agent-readiness";
import { getExecutableCommandName } from "./completion-source-gate";
import type { TerminalSessionRecord } from "./manager-records";
import type { TerminalEventService } from "./terminal-event-service";
import type { TerminalStateStore } from "./terminal-state-store";

type TerminalStateSessionSnapshot = Pick<
  TerminalSessionRecord,
  "activeCommand" | "status" | "terminalState" | "scrollback"
>;
type TerminalStatePanelSnapshot = Pick<
  TerminalStateSessionSnapshot,
  "activeCommand" | "status" | "terminalState"
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
        createAgentState(agent, "agent_starting"),
      context,
    );
  }

  setAgentStarting(
    terminalSessionId: string,
    agent: TerminalAgentKind,
    context?: Partial<TerminalStatePublishContext>,
  ): TerminalState {
    const publishContext = context
      ? {
          projectId: context.projectId ?? null,
          reason: context.reason ?? "metadata",
        }
      : undefined;
    return this.setAndPublish(
      terminalSessionId,
      createAgentState(agent, "agent_starting"),
      publishContext,
    );
  }

  setAgentIdle(
    terminalSessionId: string,
    agent: TerminalAgentKind,
    context?: Partial<TerminalStatePublishContext>,
  ): TerminalState {
    const publishContext = context
      ? {
          projectId: context.projectId ?? null,
          reason: context.reason ?? "metadata",
        }
      : undefined;
    return this.setAndPublish(
      terminalSessionId,
      createAgentState(agent, "agent_idle"),
      publishContext,
    );
  }

  setAgentRunning(
    terminalSessionId: string,
    agent: TerminalAgentKind,
    context?: Partial<TerminalStatePublishContext>,
  ): TerminalState {
    const publishContext = context
      ? {
          projectId: context.projectId ?? null,
          reason: context.reason ?? "metadata",
        }
      : undefined;
    return this.setAndPublish(
      terminalSessionId,
      createAgentState(agent, "agent_running"),
      publishContext,
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
      if (
        agentState.state === "agent_starting" &&
        hasAgentReadyPrompt(agent, sessionSnapshot.scrollback)
      ) {
        return this.setAndPublish(
          terminalSessionId,
          createAgentState(agent, "agent_idle"),
          undefined,
        );
      }
      return agentState;
    }

    if (hasAgentReadyPrompt(agent, sessionSnapshot.scrollback)) {
      return this.setAndPublish(
        terminalSessionId,
        createAgentState(agent, "agent_idle"),
        undefined,
      );
    }

    return createAgentState(agent, "agent_starting");
  }

  private setAndPublish(
    terminalSessionId: string,
    next: TerminalState,
    context: TerminalStatePublishContext | undefined,
  ): TerminalState {
    const previous = this.store.get(terminalSessionId) ?? SHELL_IDLE;
    const saved = this.store.set(terminalSessionId, next);
    const changed =
      previous.state !== next.state || previous.agent !== next.agent;
    if (changed) {
      this.onStateChange?.(terminalSessionId, next);
    }
    if (context && changed) {
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
  sessionSnapshot: Pick<TerminalSessionRecord, "activeCommand">,
): boolean {
  return getTerminalSessionAgent(sessionSnapshot) === "codex";
}

export function isCodexActiveCommand(activeCommand: string | null): boolean {
  return getAgentForCommand(activeCommand) === "codex";
}

export function getTerminalSessionAgent(
  sessionSnapshot: Pick<TerminalSessionRecord, "activeCommand">,
): TerminalAgentKind | null {
  return getAgentForCommand(sessionSnapshot.activeCommand);
}

export function getAgentForCommand(
  activeCommand: string | null,
): TerminalAgentKind | null {
  if (!activeCommand) {
    return null;
  }
  const basename = getExecutableCommandName(activeCommand);
  if (!basename) {
    return null;
  }
  for (const [agent, commands] of Object.entries(AGENT_COMMANDS)) {
    if (commands.has(basename)) {
      return agent as TerminalAgentKind;
    }
  }
  return null;
}

export function aggregatePanelTerminalState(
  panels: TerminalStatePanelSnapshot[],
): TerminalState {
  const runningPanels = panels.filter((panel) => panel.status === "running");
  const agentPanels = runningPanels
    .map((panel) => ({
      agent: panel.terminalState?.agent ?? getAgentForCommand(panel.activeCommand),
      state: panel.terminalState?.state,
    }))
    .filter(
      (panel): panel is {
        agent: TerminalAgentKind;
        state: TerminalState["state"] | undefined;
      } => Boolean(panel.agent),
    );

  const runningAgentPanel = agentPanels.find(
    (panel) => panel.state === "agent_running",
  );
  if (runningAgentPanel) {
    return createAgentState(runningAgentPanel.agent, "agent_running");
  }

  const idleAgentPanel = agentPanels[0];
  if (idleAgentPanel) {
    return createAgentState(idleAgentPanel.agent, "agent_idle");
  }

  return SHELL_IDLE;
}

function createAgentState(
  agent: TerminalAgentKind,
  state: "agent_starting" | "agent_idle" | "agent_running",
): TerminalState {
  return { state, agent };
}

export function hasAgentReadyPrompt(
  agent: TerminalAgentKind,
  scrollback: string,
): boolean {
  return agent === "codex"
    ? hasCodexReadyPrompt(scrollback)
    : hasTraeReadyPrompt(scrollback);
}
