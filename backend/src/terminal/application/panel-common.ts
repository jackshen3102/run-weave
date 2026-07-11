import type {
  TerminalPanelRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager";
import type { PtyService } from "../pty-service";
import type { TerminalRuntimeRegistry } from "../runtime-registry";
import { isTmuxBackedSession, resolveTmuxTarget } from "../runtime-launcher";
import type { TmuxPaneTarget, TmuxService } from "../tmux-service";
import type { TmuxOutputWatcher } from "../tmux-output-watcher";
import type { TerminalEventService } from "../terminal-event-service";
import type { TerminalStateService } from "../terminal-state-service";

export interface TerminalPanelOptions {
  ptyService?: PtyService;
  runtimeRegistry?: TerminalRuntimeRegistry;
  tmuxService?: TmuxService;
  tmuxOutputWatcher?: TmuxOutputWatcher;
  terminalEventService?: TerminalEventService;
  terminalStateService?: TerminalStateService;
}

export interface TerminalPanelTargetResolution {
  panel: TerminalPanelRecord;
  paneTarget: TmuxPaneTarget;
}

export class TerminalPanelError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "TerminalPanelError";
  }
}

export function getSessionOrThrow(
  terminalSessionManager: TerminalSessionManager,
  terminalSessionId: string,
): TerminalSessionRecord {
  const session = terminalSessionManager.getSession(terminalSessionId);
  if (!session) {
    throw new TerminalPanelError(404, "Terminal session not found");
  }
  return session;
}

export function requireTmuxSession(
  session: TerminalSessionRecord,
  tmuxService: TmuxService | undefined,
): TmuxService {
  if (!isTmuxBackedSession(session)) {
    throw new TerminalPanelError(409, "Panel split requires tmux runtime");
  }
  if (!tmuxService) {
    throw new TerminalPanelError(503, "Terminal tmux service unavailable");
  }
  return tmuxService;
}

export function buildPaneTarget(
  session: TerminalSessionRecord,
  tmuxService: TmuxService,
  panel: TerminalPanelRecord,
): TmuxPaneTarget {
  return {
    ...resolveTmuxTarget(session, tmuxService),
    paneId: panel.tmuxPaneId,
  };
}
