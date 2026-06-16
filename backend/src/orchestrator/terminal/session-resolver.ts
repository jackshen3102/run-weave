import type { CreateTerminalSessionRequest } from "@runweave/shared";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../../terminal/manager";
import type { PtyService } from "../../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../../terminal/runtime-registry";
import type { TmuxOutputWatcher } from "../../terminal/tmux-output-watcher";
import type { TmuxService } from "../../terminal/tmux-service";
import type { TerminalEventService } from "../../terminal/terminal-event-service";
import { ensureTerminalRuntime } from "../../terminal/runtime-launcher";
import { resolveTerminalCreateDefaults } from "../../routes/terminal-session-route-helpers";
import { toSessionListItem } from "../../routes/terminal-route-payloads";
import { OrchestratorError } from "../errors";

export class OrchestratorTerminalSessionResolver {
  constructor(
    private readonly options: {
      terminalSessionManager: TerminalSessionManager;
      terminalEventService: TerminalEventService;
      ptyService: PtyService;
      runtimeRegistry: TerminalRuntimeRegistry;
      tmuxService?: TmuxService;
      tmuxOutputWatcher?: TmuxOutputWatcher;
    },
  ) {}

  async resolveRunSession(params: {
    projectId: string;
    binding: { mode: "new" | "reuse"; sessionId?: string | null };
    terminal: Omit<CreateTerminalSessionRequest, "projectId">;
  }): Promise<TerminalSessionRecord> {
    if (params.binding.mode === "reuse") {
      if (!params.binding.sessionId) {
        throw new OrchestratorError(400, "Reusable terminal session is required");
      }
      const session = this.options.terminalSessionManager.getSession(
        params.binding.sessionId,
      );
      if (!session) {
        throw new OrchestratorError(404, "Terminal session not found");
      }
      return session;
    }
    return this.createSession({
      projectId: params.projectId,
      ...params.terminal,
    });
  }

  private async createSession(
    payload: CreateTerminalSessionRequest,
  ): Promise<TerminalSessionRecord> {
    const session = await this.options.terminalSessionManager.createSession(
      resolveTerminalCreateDefaults(payload, this.options.terminalSessionManager),
    );
    let launchSession = session;
    const runtimePreference = payload.runtimePreference ?? "auto";
    const shouldTryTmux = runtimePreference === "auto" || runtimePreference === "tmux";
    const tmuxAvailable =
      this.options.tmuxService && shouldTryTmux
        ? await this.options.tmuxService.isAvailable()
        : false;
    if (this.options.tmuxService && shouldTryTmux && tmuxAvailable) {
      const target = this.options.tmuxService.buildTarget(session.id);
      launchSession =
        (await this.options.terminalSessionManager.updateRuntimeMetadata(
          session.id,
          {
            runtimeKind: "tmux",
            tmuxSessionName: target.sessionName,
            tmuxSocketPath: target.socketPath,
            recoverable: true,
          },
        )) ?? session;
    }
    try {
      await ensureTerminalRuntime({
        session: launchSession,
        terminalSessionManager: this.options.terminalSessionManager,
        runtimeRegistry: this.options.runtimeRegistry,
        ptyService: this.options.ptyService,
        tmuxService: this.options.tmuxService,
        tmuxOutputWatcher: this.options.tmuxOutputWatcher,
        allowMissingTmuxSession: true,
      });
    } catch (error) {
      await this.options.terminalSessionManager.destroySession(session.id);
      throw error;
    }
    const created =
      this.options.terminalSessionManager.getSession(session.id) ?? launchSession;
    this.options.terminalEventService.record({
      kind: "terminal_session_created",
      terminalSessionId: created.id,
      projectId: created.projectId,
      payload: { session: toSessionListItem(created) },
    });
    return created;
  }
}
