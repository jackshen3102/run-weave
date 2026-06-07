import type { Router } from "express";
import { logger } from "../logging";
import type { TerminalSessionManager } from "../terminal/manager";
import { isTmuxBackedSession } from "../terminal/runtime-launcher";
import type { TmuxService, TmuxSessionInfo } from "../terminal/tmux-service";

const terminalTmuxLogger = logger.child({ component: "terminal" });

function resolveKnownTmuxSessionNames(
  terminalSessionManager: TerminalSessionManager,
  tmuxService: TmuxService,
): Set<string> {
  return new Set(
    terminalSessionManager
      .listSessions()
      .filter((session) => isTmuxBackedSession(session))
      .map(
        (session) =>
          session.tmuxSessionName ?? tmuxService.buildSessionName(session.id),
      ),
  );
}

function toTmuxOrphanPayload(session: TmuxSessionInfo): TmuxSessionInfo {
  return {
    sessionName: session.sessionName,
    attachedClients: session.attachedClients,
    windows: session.windows,
  };
}

export function registerTerminalTmuxOrphanRoutes(
  router: Router,
  terminalSessionManager: TerminalSessionManager,
  tmuxService: TmuxService | undefined,
): void {
  router.get("/tmux/orphans", async (_req, res) => {
    if (!tmuxService) {
      res.status(503).json({ message: "Terminal tmux service unavailable" });
      return;
    }

    try {
      const knownSessionNames = resolveKnownTmuxSessionNames(
        terminalSessionManager,
        tmuxService,
      );
      const orphanedSessions =
        await tmuxService.listOrphanedSessions(knownSessionNames);
      res.json({ items: orphanedSessions.map(toTmuxOrphanPayload) });
    } catch (error) {
      terminalTmuxLogger.error("terminal.tmux.orphan.scan.failed", {
        message: "Tmux orphan scan failed",
        error,
      });
      res.status(500).json({
        message: "Terminal tmux orphan scan failed",
        error: String(error),
      });
    }
  });

  router.delete("/tmux/orphans", async (req, res) => {
    if (!tmuxService) {
      res.status(503).json({ message: "Terminal tmux service unavailable" });
      return;
    }
    if (req.query.confirm !== "true") {
      res.status(400).json({
        message: "Set confirm=true to clean orphaned tmux sessions",
      });
      return;
    }

    try {
      const knownSessionNames = resolveKnownTmuxSessionNames(
        terminalSessionManager,
        tmuxService,
      );
      const includeAttached = req.query.includeAttached === "true";
      const orphanedSessions =
        await tmuxService.listOrphanedSessions(knownSessionNames);
      const killedSessions = await tmuxService.killOrphanedSessions(
        knownSessionNames,
        {
          includeAttached,
        },
      );
      const killedSessionNames = new Set(
        killedSessions.map((session) => session.sessionName),
      );
      const skippedSessions = orphanedSessions.filter(
        (session) => !killedSessionNames.has(session.sessionName),
      );
      res.json({
        killed: killedSessions.map(toTmuxOrphanPayload),
        skipped: skippedSessions.map(toTmuxOrphanPayload),
      });
    } catch (error) {
      terminalTmuxLogger.error("terminal.tmux.orphan.cleanup.failed", {
        message: "Tmux orphan cleanup failed",
        error,
      });
      res.status(500).json({
        message: "Terminal tmux orphan cleanup failed",
        error: String(error),
      });
    }
  });
}
