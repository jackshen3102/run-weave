import {
  hasPendingCodexTrustPrompt,
  hasStartedCodexUi,
  stripTerminalControlSequences,
  type AgentTeamTerminal,
  type TerminalAgentKind,
} from "@runweave/shared";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../terminal/manager";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import type { TmuxOutputWatcher } from "../terminal/tmux-output-watcher";
import type { TmuxPaneTarget, TmuxService } from "../terminal/tmux-service";
import { isTmuxBackedSession } from "../terminal/runtime-launcher";
import {
  getAgentForCommand,
  type TerminalStateService,
} from "../terminal/terminal-state-service";
import { sendInputToSession } from "../routes/terminal-input-dispatcher";
import {
  resolvePanelTarget,
  TerminalPanelRouteError,
} from "../routes/terminal-panel-routes";
import { AgentTeamError } from "./errors";

const AGENT_TEAM_AGENT_START_TIMEOUT_MS = 15000;
const AGENT_TEAM_AGENT_START_POLL_INTERVAL_MS = 250;

export class AgentTeamAgentReadinessService {
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

  async ensureAgentReady(
    session: TerminalSessionRecord,
    terminal: AgentTeamTerminal,
    target?: {
      panelId?: string | null;
      panelAlias?: string | null;
      role?: string | null;
    },
  ): Promise<void> {
    const agent = getAgentForCommand(terminal.command ?? null);
    if (!agent) {
      return;
    }
    const paneTarget = await this.resolvePaneTarget(session, target);
    if (await this.isAgentUiReady(session, agent, paneTarget)) {
      return;
    }

    const currentState = this.options.terminalStateService.getCurrent(
      session.id,
      session,
    );
    if (
      !target &&
      currentState.state !== "shell_idle" &&
      currentState.agent &&
      currentState.agent !== agent
    ) {
      throw new AgentTeamError(
        409,
        `Agent-team terminal is already using agent "${currentState.agent}"`,
      );
    }

    await this.sendAgentStartCommand(session, terminal, agent, paneTarget);
    await this.waitForAgentUi(session, agent, paneTarget);
  }

  private async sendAgentStartCommand(
    session: TerminalSessionRecord,
    terminal: AgentTeamTerminal,
    agent: TerminalAgentKind,
    paneTarget: TmuxPaneTarget | undefined,
  ): Promise<void> {
    if (agent === "codex" && !paneTarget) {
      this.options.terminalStateService.setAgentStarting(session.id, agent, {
        projectId: session.projectId,
        reason: "metadata",
      });
    }
    await sendInputToSession(
      this.options.terminalSessionManager,
      {
        runtimeRegistry: this.options.runtimeRegistry,
        ptyService: this.options.ptyService,
        tmuxService: this.options.tmuxService,
        tmuxOutputWatcher: this.options.tmuxOutputWatcher,
        terminalStateService: this.options.terminalStateService,
      },
      session,
      buildAgentStartCommand(terminal, agent),
      "line",
      `agent_team_agent_start_${Date.now()}`,
      paneTarget,
    );
  }

  private async waitForAgentUi(
    session: TerminalSessionRecord,
    agent: TerminalAgentKind,
    paneTarget: TmuxPaneTarget | undefined,
  ): Promise<void> {
    if (agent !== "codex") {
      return;
    }
    const deadline = Date.now() + AGENT_TEAM_AGENT_START_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      await this.acceptCodexTrustPromptIfNeeded(session, agent, paneTarget);
      if (await this.isAgentUiReady(session, agent, paneTarget)) {
        return;
      }
      await wait(AGENT_TEAM_AGENT_START_POLL_INTERVAL_MS);
    }
    throw new AgentTeamError(
      409,
      `Timed out waiting for agent-team agent "${agent}" to start`,
    );
  }

  private async acceptCodexTrustPromptIfNeeded(
    session: TerminalSessionRecord,
    agent: TerminalAgentKind,
    paneTarget: TmuxPaneTarget | undefined,
  ): Promise<void> {
    if (agent !== "codex") {
      return;
    }
    const scrollback = await this.readCleanScrollback(session, paneTarget);
    if (!hasPendingCodexTrustPrompt(scrollback)) {
      return;
    }
    await sendInputToSession(
      this.options.terminalSessionManager,
      {
        runtimeRegistry: this.options.runtimeRegistry,
        ptyService: this.options.ptyService,
        tmuxService: this.options.tmuxService,
        tmuxOutputWatcher: this.options.tmuxOutputWatcher,
        terminalStateService: this.options.terminalStateService,
      },
      session,
      "",
      "line",
      `agent_team_agent_trust_${Date.now()}`,
      paneTarget,
    );
  }

  private async isAgentUiReady(
    session: TerminalSessionRecord,
    agent: TerminalAgentKind,
    paneTarget: TmuxPaneTarget | undefined,
  ): Promise<boolean> {
    if (agent !== "codex") {
      return true;
    }
    if (!paneTarget) {
      const currentState = this.options.terminalStateService.getCurrent(
        session.id,
        session,
      );
      if (currentState.agent === agent && currentState.state === "agent_idle") {
        return true;
      }
      const scrollback = await this.readCleanScrollback(session, paneTarget);
      if (!hasStartedCodexUi(scrollback)) {
        return false;
      }
      this.options.terminalStateService.setAgentIdle(session.id, agent, {
        projectId: session.projectId,
        reason: "metadata",
      });
      return true;
    }
    const scrollback = await this.readCleanScrollback(session, paneTarget);
    if (!hasStartedCodexUi(scrollback)) {
      return false;
    }
    this.options.terminalStateService.setAgentIdle(session.id, agent, {
      projectId: session.projectId,
      reason: "metadata",
    });
    return true;
  }

  private async readCleanScrollback(
    session: TerminalSessionRecord,
    paneTarget: TmuxPaneTarget | undefined,
  ): Promise<string> {
    if (paneTarget && this.options.tmuxService) {
      const capture = await this.options.tmuxService.capturePane(
        paneTarget,
        120,
      );
      return stripTerminalControlSequences(capture.data);
    }
    const scrollback =
      await this.options.terminalSessionManager.readLiveScrollback(session.id);
    return stripTerminalControlSequences(scrollback);
  }

  private async resolvePaneTarget(
    session: TerminalSessionRecord,
    target:
      | {
          panelId?: string | null;
          panelAlias?: string | null;
          role?: string | null;
        }
      | undefined,
  ): Promise<TmuxPaneTarget | undefined> {
    if (!isTmuxBackedSession(session) || !this.options.tmuxService) {
      return undefined;
    }
    if (!target?.panelId && !target?.panelAlias && !target?.role) {
      return undefined;
    }
    try {
      return (
        await resolvePanelTarget(
          this.options.terminalSessionManager,
          session,
          { tmuxService: this.options.tmuxService },
          {
            panelId: target.panelId ?? undefined,
            panelAlias: target.panelAlias ?? undefined,
            role: target.role ?? undefined,
          },
          "explicit-or-active",
        )
      ).paneTarget;
    } catch (error) {
      if (error instanceof TerminalPanelRouteError) {
        throw new AgentTeamError(
          error.statusCode,
          error.message,
          error.details,
        );
      }
      throw error;
    }
  }
}

function buildAgentStartCommand(
  terminal: AgentTeamTerminal,
  agent: TerminalAgentKind,
): string {
  const command = terminal.command?.trim() || agent;
  const args = terminal.args ?? [];
  if (args.length === 0) {
    return command;
  }
  return [command, ...args.map(shellQuote)].join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
