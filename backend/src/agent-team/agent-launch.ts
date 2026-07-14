import type { AgentTeamTerminal } from "@runweave/shared/agent-team";
import { DEFAULT_TERMINAL_AGENT_BOOTSTRAP_PROMPT } from "@runweave/shared/terminal/agent-preparation";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../terminal/manager";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import type { TerminalStateService } from "../terminal/terminal-state-service";
import { getAgentForCommand } from "../terminal/terminal-state-service";
import type { TmuxOutputWatcher } from "../terminal/tmux-output-watcher";
import type { TmuxService } from "../terminal/tmux-service";
import { prepareTerminalAgent } from "../terminal/application/agent-preparation";
import { resolvePanelTarget } from "../terminal/application/panel-targets";
import { AgentTeamError } from "./errors";

export class AgentTeamAgentLaunchService {
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

  async submitAgentLaunch(
    session: TerminalSessionRecord,
    terminal: AgentTeamTerminal,
    target?: {
      panelId?: string | null;
      panelAlias?: string | null;
      role?: string | null;
      publishSessionState?: boolean;
      prompt?: string;
    },
  ): Promise<void> {
    const detectedAgent = getAgentForCommand(terminal.command ?? null);
    if (!detectedAgent) {
      throw new AgentTeamError(
        409,
        `Agent-team terminal command "${terminal.command ?? ""}" does not support lifecycle bootstrap`,
      );
    }
    if (detectedAgent !== "codex" && detectedAgent !== "traex") {
      throw new AgentTeamError(
        409,
        `Agent-team terminal agent "${detectedAgent}" does not support lifecycle bootstrap`,
      );
    }
    const panelTarget = await resolvePanelTarget(
      this.options.terminalSessionManager,
      session,
      {
        tmuxService: this.options.tmuxService,
      },
      {
        panelId: target?.panelId ?? undefined,
        panelAlias: target?.panelAlias ?? undefined,
        role: target?.role ?? undefined,
      },
      "explicit-or-active",
    );
    await prepareTerminalAgent(
      this.options.terminalSessionManager,
      session,
      {
        ptyService: this.options.ptyService,
        runtimeRegistry: this.options.runtimeRegistry,
        terminalStateService: this.options.terminalStateService,
        tmuxService: this.options.tmuxService,
        tmuxOutputWatcher: this.options.tmuxOutputWatcher,
      },
      {
        agent: detectedAgent,
        prompt: target?.prompt ?? DEFAULT_TERMINAL_AGENT_BOOTSTRAP_PROMPT,
        panelId: panelTarget.panel.id,
        cwd: terminal.cwd ?? session.cwd,
        command: terminal.command,
        args: terminal.args,
      },
    );
  }
}
