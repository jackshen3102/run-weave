import { type AgentTeamTerminal } from "@runweave/shared/agent-team";
import { TERMINAL_CLIENT_SCROLLBACK_LINES } from "@runweave/shared/terminal-limits";
import {
  hasCodexRestartRequiredAfterUpdate,
  hasPendingCodexTrustPrompt,
  hasPendingCodexUpdatePrompt,
  hasStartedCodexUi,
  hasTraeReadyPrompt,
  hasTraeStartupFailure,
  stripTerminalControlSequences,
} from "@runweave/shared/terminal-agent-readiness";
import { type TerminalAgentKind } from "@runweave/shared/terminal/state";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../terminal/manager";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import type {
  TmuxOutputWatcher,
  TmuxPaneOutputCursor,
} from "../terminal/tmux-output-watcher";
import type { TmuxPaneTarget, TmuxService } from "../terminal/tmux-service";
import { isTmuxBackedSession } from "../terminal/runtime-launcher";
import {
  getAgentForCommand,
  type TerminalStateService,
} from "../terminal/terminal-state-service";
import { sendInputToSession } from "../terminal/application/input-dispatcher";
import { TerminalPanelError } from "../terminal/application/panel-common";
import { resolvePanelTarget } from "../terminal/application/panel-targets";
import { AgentTeamError } from "./errors";

const AGENT_TEAM_AGENT_START_TIMEOUT_MS = 15000;
const AGENT_TEAM_AGENT_START_POLL_INTERVAL_MS = 250;
const CODEX_SKIP_UPDATE_ON_STARTUP_ARGS = [
  "-c",
  "check_for_update_on_startup=false",
] as const;

type TraeStartupOutputBoundary =
  | {
      kind: "pty";
      cursor: number;
    }
  | {
      kind: "tmux-pane";
      cursor: TmuxPaneOutputCursor;
      target: TmuxPaneTarget;
    };

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
      publishSessionState?: boolean;
    },
  ): Promise<void> {
    const agent = getAgentForCommand(terminal.command ?? null);
    if (!agent) {
      return;
    }
    const publishSessionState = target?.publishSessionState ?? !target;
    const paneTarget = await this.resolvePaneTarget(session, target);
    if (
      await this.isAgentUiReady(session, agent, paneTarget, {
        publishSessionState,
      })
    ) {
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

    let traeStartupOutputBoundary: TraeStartupOutputBoundary | undefined;
    if (agent !== "codex" && isTmuxBackedSession(session)) {
      this.setAgentStarting(session, agent, publishSessionState);
      traeStartupOutputBoundary =
        await this.captureTraeStartupOutputBoundary(
          session,
          paneTarget,
          buildAgentStartCommand(terminal, agent),
        );
    } else {
      traeStartupOutputBoundary =
        agent === "codex"
          ? undefined
          : await this.captureTraeStartupOutputBoundary(session, paneTarget);
      await this.sendAgentStartCommand(session, terminal, agent, paneTarget, {
        publishSessionState,
      });
    }
    await this.waitForAgentUi(session, terminal, agent, paneTarget, {
      publishSessionState,
      traeStartupOutputBoundary,
    });
  }

  private async sendAgentStartCommand(
    session: TerminalSessionRecord,
    terminal: AgentTeamTerminal,
    agent: TerminalAgentKind,
    paneTarget: TmuxPaneTarget | undefined,
    options: { publishSessionState: boolean },
  ): Promise<void> {
    this.setAgentStarting(session, agent, options.publishSessionState);
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

  private setAgentStarting(
    session: TerminalSessionRecord,
    agent: TerminalAgentKind,
    publishSessionState: boolean,
  ): void {
    if (!publishSessionState) {
      return;
    }
    this.options.terminalStateService.setAgentStarting(session.id, agent, {
      projectId: session.projectId,
      reason: "metadata",
    });
  }

  private async waitForAgentUi(
    session: TerminalSessionRecord,
    terminal: AgentTeamTerminal,
    agent: TerminalAgentKind,
    paneTarget: TmuxPaneTarget | undefined,
    options: {
      publishSessionState: boolean;
      traeStartupOutputBoundary?: TraeStartupOutputBoundary;
    },
  ): Promise<void> {
    const deadline = Date.now() + AGENT_TEAM_AGENT_START_TIMEOUT_MS;
    let skippedCodexUpdatePrompt = false;
    let restartedAfterCodexUpdate = false;
    while (Date.now() <= deadline) {
      const startupInterruptionHandled =
        await this.handleCodexStartupInterruptionIfNeeded(
          session,
          terminal,
          agent,
          paneTarget,
          options,
          {
            canSkipUpdatePrompt: !skippedCodexUpdatePrompt,
            canRestartAfterUpdate: !restartedAfterCodexUpdate,
          },
        );
      if (startupInterruptionHandled === "skipped_update_prompt") {
        skippedCodexUpdatePrompt = true;
        await wait(AGENT_TEAM_AGENT_START_POLL_INTERVAL_MS);
        continue;
      }
      if (startupInterruptionHandled === "restarted_after_update") {
        restartedAfterCodexUpdate = true;
        await wait(AGENT_TEAM_AGENT_START_POLL_INTERVAL_MS);
        continue;
      }
      await this.acceptCodexTrustPromptIfNeeded(session, agent, paneTarget);
      let traeStartupOutput: string | undefined;
      let traeVisibleScrollback: string | undefined;
      if (agent !== "codex") {
        traeVisibleScrollback = await this.readCleanScrollback(
          session,
          paneTarget,
          TERMINAL_CLIENT_SCROLLBACK_LINES,
        );
        const freshTraeStartupOutput = await this.readTraeStartupOutput(
          session,
          options.traeStartupOutputBoundary,
        );
        if (freshTraeStartupOutput === null) {
          throw new AgentTeamError(
            409,
            `Lost pane-local output boundary while starting agent-team agent "${agent}"`,
            {
              agent,
              terminalSessionId: session.id,
              panelId: paneTarget?.paneId ?? null,
              reason: "startup_output_boundary_lost",
            },
          );
        }
        traeStartupOutput = freshTraeStartupOutput;
        if (hasTraeStartupFailure(traeStartupOutput)) {
          throw new AgentTeamError(
            409,
            `Agent-team agent "${agent}" failed before becoming ready`,
            {
              agent,
              terminalSessionId: session.id,
              panelId: paneTarget?.paneId ?? null,
              reason: "startup_failure",
            },
          );
        }
      }
      if (
        await this.isAgentUiReady(session, agent, paneTarget, {
          publishSessionState: options.publishSessionState,
          traeStartupOutput,
          traeVisibleScrollback,
        })
      ) {
        return;
      }
      await wait(AGENT_TEAM_AGENT_START_POLL_INTERVAL_MS);
    }
    throw new AgentTeamError(
      409,
      `Timed out waiting for agent-team agent "${agent}" to start`,
    );
  }

  private async handleCodexStartupInterruptionIfNeeded(
    session: TerminalSessionRecord,
    terminal: AgentTeamTerminal,
    agent: TerminalAgentKind,
    paneTarget: TmuxPaneTarget | undefined,
    options: { publishSessionState: boolean },
    controls: {
      canSkipUpdatePrompt: boolean;
      canRestartAfterUpdate: boolean;
    },
  ): Promise<"skipped_update_prompt" | "restarted_after_update" | null> {
    if (agent !== "codex") {
      return null;
    }
    const scrollback = await this.readCleanScrollback(session, paneTarget);
    if (
      controls.canSkipUpdatePrompt &&
      hasPendingCodexUpdatePrompt(scrollback)
    ) {
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
        "2",
        "line",
        `agent_team_agent_skip_update_${Date.now()}`,
        paneTarget,
      );
      return "skipped_update_prompt";
    }
    if (
      controls.canRestartAfterUpdate &&
      hasCodexRestartRequiredAfterUpdate(scrollback)
    ) {
      await this.sendAgentStartCommand(session, terminal, agent, paneTarget, {
        publishSessionState: options.publishSessionState,
      });
      return "restarted_after_update";
    }
    return null;
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
    options: {
      publishSessionState: boolean;
      traeStartupOutput?: string;
      traeVisibleScrollback?: string;
    },
  ): Promise<boolean> {
    if (!(await this.hasActiveAgentOwner(session, agent, paneTarget))) {
      return false;
    }
    if (options.publishSessionState) {
      const currentState = this.options.terminalStateService.getCurrent(
        session.id,
        session,
      );
      if (
        agent === "codex" &&
        currentState.agent === agent &&
        currentState.state === "agent_idle"
      ) {
        return true;
      }
      const scrollback =
        options.traeVisibleScrollback ??
        (await this.readCleanScrollback(session, paneTarget));
      if (!hasStartedAgentUi(agent, scrollback, options.traeStartupOutput)) {
        return false;
      }
      this.options.terminalStateService.setAgentIdle(session.id, agent, {
        projectId: session.projectId,
        reason: "metadata",
      });
      return true;
    }
    const scrollback =
      options.traeVisibleScrollback ??
      (await this.readCleanScrollback(session, paneTarget));
    if (!hasStartedAgentUi(agent, scrollback, options.traeStartupOutput)) {
      return false;
    }
    return true;
  }

  private async hasActiveAgentOwner(
    session: TerminalSessionRecord,
    agent: TerminalAgentKind,
    paneTarget: TmuxPaneTarget | undefined,
  ): Promise<boolean> {
    const activeCommand =
      paneTarget && this.options.tmuxService
        ? ((
            await this.options.tmuxService.readPaneMetadata(
              paneTarget,
              session.command,
            )
          )?.activeCommand ?? null)
        : session.activeCommand;
    return hasMatchingAgentReadinessOwner(activeCommand, agent);
  }

  private async readCleanScrollback(
    session: TerminalSessionRecord,
    paneTarget: TmuxPaneTarget | undefined,
    historyLines = 120,
  ): Promise<string> {
    if (paneTarget && this.options.tmuxService) {
      const capture = await this.options.tmuxService.capturePane(
        paneTarget,
        historyLines,
      );
      return stripTerminalControlSequences(capture.data);
    }
    const scrollback =
      await this.options.terminalSessionManager.readLiveScrollback(session.id);
    return stripTerminalControlSequences(scrollback);
  }

  private async captureTraeStartupOutputBoundary(
    session: TerminalSessionRecord,
    paneTarget: TmuxPaneTarget | undefined,
    tmuxStartInput?: string,
  ): Promise<TraeStartupOutputBoundary> {
    if (isTmuxBackedSession(session)) {
      if (
        !paneTarget ||
        !this.options.tmuxOutputWatcher ||
        !tmuxStartInput
      ) {
        throw this.createTraeOutputBoundaryError(session, paneTarget);
      }
      const cursor =
        await this.options.tmuxOutputWatcher.capturePaneOutputCursorAndSendInput(
          session,
          paneTarget,
          tmuxStartInput,
        );
      if (!cursor) {
        throw this.createTraeOutputBoundaryError(session, paneTarget);
      }
      return { kind: "tmux-pane", cursor, target: paneTarget };
    }

    const cursor =
      await this.options.terminalSessionManager.captureOutputCursor(session.id);
    if (cursor === null) {
      throw this.createTraeOutputBoundaryError(session, paneTarget);
    }
    return { kind: "pty", cursor };
  }

  private async readTraeStartupOutput(
    session: TerminalSessionRecord,
    boundary: TraeStartupOutputBoundary | undefined,
  ): Promise<string | null> {
    if (!boundary) {
      return null;
    }
    if (boundary.kind === "tmux-pane") {
      return (
        (await this.options.tmuxOutputWatcher?.readPaneOutputSince(
          boundary.target,
          boundary.cursor,
        )) ?? null
      );
    }
    return this.options.terminalSessionManager.readOutputSince(
      session.id,
      boundary.cursor,
    );
  }

  private createTraeOutputBoundaryError(
    session: TerminalSessionRecord,
    paneTarget: TmuxPaneTarget | undefined,
  ): AgentTeamError {
    return new AgentTeamError(
      409,
      `Failed to establish pane-local output boundary for agent-team agent "traex"`,
      {
        terminalSessionId: session.id,
        panelId: paneTarget?.paneId ?? null,
        reason: "startup_output_boundary_unavailable",
      },
    );
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
      const tmuxTarget = {
        sessionName:
          session.tmuxSessionName ??
          this.options.tmuxService.buildSessionName(session.id),
        socketPath:
          session.tmuxSocketPath ?? this.options.tmuxService.socketPath,
      };
      const paneId =
        await this.options.tmuxService.readSelectedPane(tmuxTarget);
      if (!paneId) {
        throw new AgentTeamError(
          409,
          "Failed to resolve pane-local target for agent-team terminal",
          {
            terminalSessionId: session.id,
            reason: "pane_target_unavailable",
          },
        );
      }
      return { ...tmuxTarget, paneId };
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
      if (error instanceof TerminalPanelError) {
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

function hasStartedAgentUi(
  agent: TerminalAgentKind,
  scrollback: string,
  traeStartupOutput?: string,
): boolean {
  if (agent === "codex") {
    return hasStartedCodexUi(scrollback);
  }
  return (
    hasTraeReadyPrompt(scrollback) &&
    (traeStartupOutput === undefined || hasTraeReadyPrompt(traeStartupOutput))
  );
}

export function hasMatchingAgentReadinessOwner(
  activeCommand: string | null,
  agent: TerminalAgentKind,
): boolean {
  const activeAgent = getAgentForCommand(activeCommand);
  return agent === "codex"
    ? activeAgent === "codex"
    : activeAgent !== null && activeAgent !== "codex";
}

function buildAgentStartCommand(
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
