import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../terminal/manager";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import type { TerminalStateService } from "../terminal/terminal-state-service";
import type { TmuxOutputWatcher } from "../terminal/tmux-output-watcher";
import type { TmuxService } from "../terminal/tmux-service";
import { sendInputToSession } from "../terminal/application/input-dispatcher";
import { TerminalPanelError } from "../terminal/application/panel-common";
import { resolvePanelTarget } from "../terminal/application/panel-targets";
import { AgentTeamError } from "./errors";

/**
 * Injects prompts into a terminal session, optionally targeting a specific
 * tmux pane. Migrated from the retired orchestrator prompt-sender; the
 * bracketed-paste + chunked key-sequence approach is the low-level terminal
 * capability the agent-team loop reuses.
 */
export class AgentTeamPromptSender {
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

  async sendPromptToPane(
    session: TerminalSessionRecord,
    text: string,
    target?: {
      panelId?: string | null;
      panelAlias?: string | null;
      role?: string | null;
    },
  ): Promise<void> {
    let paneTarget;
    if (target?.panelId || target?.panelAlias || target?.role) {
      try {
        paneTarget = (
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
    await sendInputToSession(
      this.options.terminalSessionManager,
      this.options,
      session,
      text,
      "prompt_paste",
      undefined,
      paneTarget,
    );
  }
}
