import type { Response } from "express";
import type {
  TerminalPanelRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../terminal/manager";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import { isTmuxBackedSession, resolveTmuxTarget } from "../terminal/runtime-launcher";
import type { TmuxPaneTarget, TmuxService } from "../terminal/tmux-service";
import type { TmuxOutputWatcher } from "../terminal/tmux-output-watcher";
import type { TerminalEventService } from "../terminal/terminal-event-service";
import type { TerminalStateService } from "../terminal/terminal-state-service";

export interface TerminalPanelRouteOptions {
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

export class TerminalPanelRouteError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "TerminalPanelRouteError";
  }
}

export function getSessionOrThrow(
  terminalSessionManager: TerminalSessionManager,
  terminalSessionId: string,
): TerminalSessionRecord {
  const session = terminalSessionManager.getSession(terminalSessionId);
  if (!session) {
    throw new TerminalPanelRouteError(404, "Terminal session not found");
  }
  return session;
}

export function requireTmuxSession(
  session: TerminalSessionRecord,
  tmuxService: TmuxService | undefined,
): TmuxService {
  if (!isTmuxBackedSession(session)) {
    throw new TerminalPanelRouteError(
      409,
      "Panel split requires tmux runtime",
    );
  }
  if (!tmuxService) {
    throw new TerminalPanelRouteError(503, "Terminal tmux service unavailable");
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

export function sendTerminalPanelRouteError(
  res: Response,
  error: unknown,
): boolean {
  if (error instanceof TerminalPanelRouteError) {
    res.status(error.statusCode).json({
      message: error.message,
      details: error.details,
    });
    return true;
  }
  return false;
}
