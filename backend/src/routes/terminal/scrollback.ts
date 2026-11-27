import type { Router } from "express";
import { z } from "zod";
import type { TerminalAnsiScrollbackResponse } from "@runweave/shared/terminal/session";
import type { TerminalSessionManager } from "../../terminal/manager/manager";
import { isTmuxBackedSession } from "../../terminal/runtime/launcher";
import type { TmuxService } from "../../terminal/tmux/service";
import type { TerminalEventService } from "../../terminal/state/terminal-event-service";
import { logger } from "../../logging/index";
import {
  resolvePanelTarget,
  sendTerminalPanelRouteError,
} from "./panels/index";

const terminalLogger = logger.child({ component: "terminal" });

const ansiScrollbackQuerySchema = z
  .object({
    panelId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export function registerTerminalScrollbackRoutes(
  router: Router,
  terminalSessionManager: TerminalSessionManager,
  options?: {
    tmuxService?: TmuxService;
    terminalEventService?: TerminalEventService;
  },
): void {
  router.get("/session/:id/scrollback/ansi", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const parsedQuery = ansiScrollbackQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({
        code: "INVALID_REQUEST",
        message: "Invalid scrollback query parameters",
      });
      return;
    }

    const session = terminalSessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }

    if (
      session.status !== "running" ||
      !isTmuxBackedSession(session) ||
      !options?.tmuxService
    ) {
      res.status(409).json({
        code: "SCROLLBACK_ANSI_UNSUPPORTED",
        message: "ANSI scrollback is only supported for running tmux sessions",
      });
      return;
    }

    try {
      const target = options.tmuxService.buildTarget(session.id);
      if (!(await options.tmuxService.hasSession(target))) {
        res.status(409).json({
          code: "SCROLLBACK_ANSI_UNSUPPORTED",
          message: "Tmux session is not running",
        });
        return;
      }

      const { paneTarget } = await resolvePanelTarget(
        terminalSessionManager,
        session,
        {
          tmuxService: options.tmuxService,
          terminalEventService: options.terminalEventService,
        },
        { panelId: parsedQuery.data.panelId },
        "explicit-or-active",
      );
      const [capture, scrollState] = await Promise.all([
        options.tmuxService.capturePaneAnsiHistory(paneTarget),
        typeof options.tmuxService.readScrollState === "function"
          ? options.tmuxService.readScrollState(paneTarget).catch(() => null)
          : Promise.resolve(null),
      ]);
      const payload: TerminalAnsiScrollbackResponse = {
        terminalSessionId: session.id,
        paneId: capture.paneId,
        sourceCols: capture.sourceCols,
        lineCount: capture.lineCount,
        data: capture.data,
        ...(scrollState
          ? { owner: scrollState.owner, copyMode: scrollState.copyMode }
          : {}),
      };
      res.json(payload);
    } catch (error) {
      if (sendTerminalPanelRouteError(res, error)) {
        return;
      }
      terminalLogger.warn("terminal.session.scrollback.ansi.failed", {
        message: "Failed to capture terminal ANSI scrollback",
        terminalSessionId: session.id,
        error,
      });
      res.status(503).json({
        code: "SCROLLBACK_ANSI_UNAVAILABLE",
        message: "Failed to capture terminal ANSI scrollback",
      });
    }
  });
}
