import type { CreateTerminalSessionRequest } from "@runweave/shared/terminal/session";
import type { ScheduledTaskSource } from "@runweave/shared/scheduled-tasks";
import type { TerminalSessionManager } from "../manager/manager";
import type { TerminalActivityDependencies } from "../runtime/activity-events";
import { recordTerminalSessionCreated } from "../runtime/activity-events";
import {
  ensureTerminalRuntime,
  isTmuxBackedSession,
  killTmuxSessionForTerminal,
} from "../runtime/launcher";
import type { PtyService } from "../runtime/pty-service";
import type { TerminalRuntimeRegistry } from "../runtime/registry";
import type { TerminalEventService } from "../state/terminal-event-service";
import type { TerminalStateService } from "../state/terminal-state-service";
import type { TmuxOutputWatcher } from "../tmux/output-watcher";
import type { TmuxService } from "../tmux/service";
import { logger } from "../../logging/index";
import { ensureTerminalPanelWorkspace } from "./panel-workspace";
import { toPanelWorkspacePayload, toSessionListItem } from "./payloads";
import { resolveEffectiveTerminalState } from "./terminal-state-projection";
import { resolveTerminalCreateDefaults } from "./create-defaults";

const terminalLogger = logger.child({ component: "terminal" });

export interface TerminalSessionCreationOptions {
  ptyService?: PtyService;
  runtimeRegistry?: TerminalRuntimeRegistry;
  tmuxService?: TmuxService;
  tmuxOutputWatcher?: TmuxOutputWatcher;
  terminalEventService?: TerminalEventService;
  terminalStateService?: TerminalStateService;
  activity?: TerminalActivityDependencies;
  strictDefaultPanel?: boolean;
}

export async function createTerminalSession(
  manager: TerminalSessionManager,
  request: CreateTerminalSessionRequest,
  options: TerminalSessionCreationOptions,
  source?: ScheduledTaskSource,
) {
  const defaults = resolveTerminalCreateDefaults(request, manager);
  const session = await manager.createSession({ ...defaults, source });
  try {
    if (options.ptyService && options.runtimeRegistry) {
      let launchSession = session;
      const preference = request.runtimePreference ?? "auto";
      const shouldTryTmux = preference === "auto" || preference === "tmux";
      let attemptedTarget: ReturnType<TmuxService["buildTarget"]> | null = null;
      const tmuxAvailable = options.tmuxService && shouldTryTmux ? await options.tmuxService.isAvailable() : false;
      const unavailableReason = options.tmuxService && shouldTryTmux && !tmuxAvailable ? await options.tmuxService.getUnavailableReason() : null;
      if (options.tmuxService && shouldTryTmux && tmuxAvailable) {
        attemptedTarget = options.tmuxService.buildTarget(session.id);
        launchSession = (await manager.updateRuntimeMetadata(session.id, { runtimeKind: "tmux", tmuxSessionName: attemptedTarget.sessionName, tmuxSocketPath: attemptedTarget.socketPath, recoverable: true })) ?? session;
      } else if (options.tmuxService && shouldTryTmux) {
        launchSession = (await manager.updateRuntimeMetadata(session.id, { runtimeKind: "pty", tmuxUnavailableReason: unavailableReason ?? "tmux unavailable", recoverable: false })) ?? session;
      }
      try {
        await ensureTerminalRuntime({ session: launchSession, terminalSessionManager: manager, runtimeRegistry: options.runtimeRegistry, ptyService: options.ptyService, tmuxService: options.tmuxService, tmuxOutputWatcher: options.tmuxOutputWatcher, allowMissingTmuxSession: true });
      } catch (error) {
        if (preference !== "auto" || !options.tmuxService || !isTmuxBackedSession(launchSession)) throw error;
        terminalLogger.warn("terminal.session.runtime.tmux-launch-fallback", { terminalSessionId: session.id, error: String(error) });
        if (attemptedTarget) await options.tmuxService.killSession(attemptedTarget);
        launchSession = (await manager.updateRuntimeMetadata(session.id, { runtimeKind: "pty", tmuxUnavailableReason: "tmux launch failed; fell back to pty", recoverable: false })) ?? session;
        await ensureTerminalRuntime({ session: launchSession, terminalSessionManager: manager, runtimeRegistry: options.runtimeRegistry, ptyService: options.ptyService, tmuxService: options.tmuxService, tmuxOutputWatcher: options.tmuxOutputWatcher, allowMissingTmuxSession: true });
      }
    }
    const created = manager.getSession(session.id) ?? session;
    if (options.tmuxService && isTmuxBackedSession(created)) {
      try {
        await ensureTerminalPanelWorkspace(manager, created, { ptyService: options.ptyService, runtimeRegistry: options.runtimeRegistry, tmuxService: options.tmuxService, tmuxOutputWatcher: options.tmuxOutputWatcher, terminalEventService: options.terminalEventService });
      } catch (error) {
        if (options.strictDefaultPanel) throw error;
        terminalLogger.warn("terminal.session.default-panel.failed", {
          message: "Create terminal default panel failed",
          terminalSessionId: created.id,
          error: String(error),
        });
      }
    }
    options.terminalEventService?.record({
      kind: "terminal_session_created", terminalSessionId: created.id, projectId: created.projectId,
      payload: { session: toSessionListItem(created, resolveEffectiveTerminalState(manager, options.terminalStateService, created), toPanelWorkspacePayload(manager, created.id)) },
    });
    recordTerminalSessionCreated(options.activity, created);
    return created;
  } catch (error) {
    await options.runtimeRegistry?.disposeRuntime(session.id);
    await options.tmuxOutputWatcher?.unwatchSession(session.id);
    await killTmuxSessionForTerminal(
      manager.getSession(session.id) ?? session,
      options.tmuxService,
    );
    await manager.destroySession(session.id);
    throw error;
  }
}
