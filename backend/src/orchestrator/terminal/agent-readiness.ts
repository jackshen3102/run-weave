import type {
  OrchestratorRoleDefinition,
  TerminalAgentKind,
} from "@runweave/shared";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../../terminal/manager";
import type { PtyService } from "../../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../../terminal/runtime-registry";
import type { TmuxOutputWatcher } from "../../terminal/tmux-output-watcher";
import type { TmuxService } from "../../terminal/tmux-service";
import {
  getAgentForCommand,
  type TerminalStateService,
} from "../../terminal/terminal-state-service";
import { sendInputToSession } from "../../routes/terminal-input-dispatcher";
import { OrchestratorError } from "../errors";
import type { AgentSnapshot } from "../types";

const ORCHESTRATOR_AGENT_START_TIMEOUT_MS = 15000;
const ORCHESTRATOR_AGENT_START_POLL_INTERVAL_MS = 250;

export class OrchestratorAgentReadinessService {
  constructor(
    private readonly options: {
      terminalSessionManager: TerminalSessionManager;
      ptyService: PtyService;
      runtimeRegistry: TerminalRuntimeRegistry;
      terminalStateService: TerminalStateService;
      tmuxService?: TmuxService;
      tmuxOutputWatcher?: TmuxOutputWatcher;
    },
  ) {}

  async ensureOrchestratorAgentReady(
    session: TerminalSessionRecord,
    terminal: OrchestratorRoleDefinition["terminal"],
  ): Promise<void> {
    const agent = resolveOrchestratorAgent(terminal.command);
    if (!agent) {
      return;
    }

    const initial = this.getAgentSnapshot(session.id, session);
    if (isRequestedAgentReady(initial, agent)) {
      return;
    }
    if (initial.currentAgent && initial.currentAgent !== agent) {
      throw new OrchestratorError(
        409,
        `Orchestrator terminal is already using agent "${initial.currentAgent}"`,
      );
    }

    const latest = this.requireSession(session.id);
    await sendInputToSession(
      this.options.terminalSessionManager,
      {
        runtimeRegistry: this.options.runtimeRegistry,
        ptyService: this.options.ptyService,
        tmuxService: this.options.tmuxService,
        tmuxOutputWatcher: this.options.tmuxOutputWatcher,
        terminalStateService: this.options.terminalStateService,
      },
      latest,
      terminal.command?.trim() || agent,
      "line",
      `orchestrator_agent_start_${Date.now()}`,
    );
    await this.waitForOrchestratorAgent(session.id, agent);
  }

  private async waitForOrchestratorAgent(
    terminalSessionId: string,
    agent: TerminalAgentKind,
  ): Promise<void> {
    const deadline = Date.now() + ORCHESTRATOR_AGENT_START_TIMEOUT_MS;
    let latest = this.getAgentSnapshot(terminalSessionId);
    while (Date.now() <= deadline) {
      latest = this.getAgentSnapshot(terminalSessionId);
      if (isRequestedAgentReady(latest, agent)) {
        return;
      }
      await wait(ORCHESTRATOR_AGENT_START_POLL_INTERVAL_MS);
    }

    throw new OrchestratorError(
      409,
      `Timed out waiting for orchestrator agent "${agent}" to start. Last state=${latest.terminalState.state}, agent=${latest.terminalState.agent ?? "none"}, activeCommand=${latest.activeCommand ?? "none"}`,
    );
  }

  private getAgentSnapshot(
    terminalSessionId: string,
    fallback?: TerminalSessionRecord,
  ): AgentSnapshot {
    const session =
      this.options.terminalSessionManager.getSession(terminalSessionId) ?? fallback;
    if (!session) {
      throw new OrchestratorError(404, "Terminal session not found");
    }
    const terminalState = this.options.terminalStateService.getCurrent(
      terminalSessionId,
      session,
    );
    const currentAgent =
      (terminalState.state !== "shell_idle" ? terminalState.agent : null) ??
      getAgentForCommand(session.activeCommand);
    return {
      activeCommand: session.activeCommand,
      currentAgent,
      terminalState,
    };
  }

  private requireSession(terminalSessionId: string): TerminalSessionRecord {
    const session =
      this.options.terminalSessionManager.getSession(terminalSessionId);
    if (!session) {
      throw new OrchestratorError(404, "Terminal session not found");
    }
    return session;
  }
}

function resolveOrchestratorAgent(
  command: string | undefined,
): TerminalAgentKind | null {
  return getAgentForCommand(command ?? null);
}

function isRequestedAgentReady(
  snapshot: AgentSnapshot,
  agent: TerminalAgentKind,
): boolean {
  return snapshot.terminalState.state !== "shell_idle" && snapshot.currentAgent === agent;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
