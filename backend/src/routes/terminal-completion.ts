import { Router } from "express";
import { z } from "zod";
import type { TerminalCompletionEvent } from "@runweave/shared/terminal/completion";
import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import { logger } from "../logging";
import type { TerminalCompletionEventService } from "../terminal/completion-event-service";
import {
  AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS,
  getCompletionSourceForCommand,
  isCompletionSourceAllowedForCommand,
} from "../terminal/completion-source-gate";
import type { TerminalSessionManager } from "../terminal/manager";
import { getTerminalSessionAgent } from "../terminal/terminal-state-service";

const completionReasonEnum = z.enum([
  "hook_stop",
  "notify",
  "ai_process_exit",
  "manual",
]);
const terminalCompletionLogger = logger.child({
  component: "terminal-completion",
});

const completionEventSchema = z
  .object({
    terminalSessionId: z.string().trim().min(1),
    source: z
      .enum(["claude", "codex", "trae", "traecli", "traex", "unknown"])
      .default("unknown"),
    completionReason: completionReasonEnum.optional(),
    commandName: z.string().trim().min(1).nullable().optional(),
    rawHookEvent: z.string().trim().min(1).nullable().optional(),
    // deprecated: accepted for backward compat, mapped to rawHookEvent
    hookEvent: z.string().trim().min(1).optional(),
    cwd: z.string().trim().min(1).nullable().optional(),
    outboxPath: z.string().trim().min(1).nullable().optional(),
    summary: z.string().trim().min(1).nullable().optional(),
    panelId: z.string().trim().min(1).nullable().optional(),
    tmuxPaneId: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

export function createInternalTerminalCompletionRouter(options: {
  completionEventService: TerminalCompletionEventService;
  terminalSessionManager: TerminalSessionManager;
  hookToken: string | undefined;
}): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const expectedToken = options.hookToken;
    if (!expectedToken) {
      terminalCompletionLogger.warn("terminal-completion.hook.unavailable", {
        message: "Terminal completion hook unavailable; no token configured",
      });
      res.status(503).json({ message: "Terminal completion hook unavailable" });
      return;
    }

    if (req.header("x-runweave-hook-token") !== expectedToken) {
      terminalCompletionLogger.warn("terminal-completion.hook.unauthorized", {
        message: "Terminal completion hook token rejected",
      });
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const parsed = completionEventSchema.safeParse(req.body);
    if (!parsed.success) {
      terminalCompletionLogger.warn("terminal-completion.body.invalid", {
        message: "Terminal completion request body invalid",
        errors: parsed.error.flatten(),
      });
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    const session = options.terminalSessionManager.getSession(
      parsed.data.terminalSessionId,
    );
    if (!session) {
      terminalCompletionLogger.warn("terminal-completion.session.missing", {
        message: "Terminal completion session not found",
        terminalSessionId: parsed.data.terminalSessionId,
      });
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }

    const rawHookEvent =
      parsed.data.rawHookEvent ?? parsed.data.hookEvent ?? null;
    const resolvedPane = resolveCompletionPane(
      options.terminalSessionManager,
      session.id,
      parsed.data.panelId ?? null,
      parsed.data.tmuxPaneId ?? null,
    );
    if (!resolvedPane.ok) {
      terminalCompletionLogger.warn("terminal-completion.pane.invalid", {
        message: "Terminal completion pane identity rejected",
        terminalSessionId: parsed.data.terminalSessionId,
        panelId: parsed.data.panelId ?? null,
        tmuxPaneId: parsed.data.tmuxPaneId ?? null,
        reason: resolvedPane.reason,
      });
      res.status(202).json({
        event: null,
        ignored: true,
        reason: resolvedPane.reason,
      });
      return;
    }
    const { panelId, tmuxPaneId } = resolvedPane;
    const paneActiveCommand = panelId
      ? (options.terminalSessionManager.getPanel(panelId)?.activeCommand ?? null)
      : null;
    const effectiveSource = resolveEffectiveCompletionSource({
      reportedSource: parsed.data.source,
      paneActiveCommand,
      sessionActiveCommand: session.activeCommand,
      commandName: parsed.data.commandName ?? null,
    });
    const lastAiActiveCommand =
      options.terminalSessionManager.getLastAiActiveCommand(session.id);
    const currentCommandMatches =
      isCompletionSourceAllowedForCommand(
        effectiveSource,
        session.activeCommand,
      ) ||
      isCompletionSourceAllowedForCommand(
        effectiveSource,
        paneActiveCommand,
      ) ||
      isCompletionSourceAllowedForCommand(
        effectiveSource,
        parsed.data.commandName ?? null,
      ) ||
      getTerminalSessionAgent(session) === effectiveSource;
    const now = Date.now();
    const graceCommandMatches =
      session.activeCommand === null &&
      lastAiActiveCommand !== null &&
      lastAiActiveCommand.source === effectiveSource &&
      lastAiActiveCommand.clearedAt !== null &&
      now - lastAiActiveCommand.clearedAt <=
        AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS;

    if (!currentCommandMatches && !graceCommandMatches) {
      terminalCompletionLogger.info("terminal-completion.ignored", {
        message: "Terminal completion event ignored",
        terminalSessionId: parsed.data.terminalSessionId,
        source: parsed.data.source,
        effectiveSource,
        activeCommand: session.activeCommand,
        paneActiveCommand,
        lastAiActiveCommand: lastAiActiveCommand?.command ?? null,
        lastAiActiveCommandClearedAt: lastAiActiveCommand?.clearedAt
          ? new Date(lastAiActiveCommand.clearedAt).toISOString()
          : null,
        rawHookEvent,
      });
      res.status(202).json({ event: null, ignored: true });
      return;
    }

    let event: TerminalEventEnvelope;
    try {
      event = await options.completionEventService.record(
        {
          terminalSessionId: parsed.data.terminalSessionId,
          source: effectiveSource,
          completionReason: parsed.data.completionReason ?? "hook_stop",
          commandName: parsed.data.commandName ?? null,
          rawHookEvent,
          cwd: parsed.data.cwd ?? null,
          outboxPath: parsed.data.outboxPath ?? null,
          summary: parsed.data.summary ?? null,
          panelId,
          tmuxPaneId,
        },
        session,
      );
    } catch (error) {
      terminalCompletionLogger.error("terminal-completion.record.failed", {
        message: "Terminal completion event failed to persist",
        terminalSessionId: parsed.data.terminalSessionId,
        error,
      });
      res.status(500).json({ message: "Terminal completion event failed" });
      return;
    }
    terminalCompletionLogger.info("terminal-completion.recorded", {
      message: "Terminal completion event recorded",
      id: event.id,
      terminalSessionId: event.terminalSessionId,
      source: event.kind === "completion" ? event.payload.source : null,
      reportedSource: parsed.data.source,
      activeCommand: session.activeCommand,
      paneActiveCommand,
      lastAiActiveCommand: lastAiActiveCommand?.command ?? null,
      lastAiActiveCommandClearedAt: lastAiActiveCommand?.clearedAt
        ? new Date(lastAiActiveCommand.clearedAt).toISOString()
        : null,
      rawHookEvent,
    });
    res.status(202).json({ event });
  });

  return router;
}

function resolveEffectiveCompletionSource(params: {
  reportedSource: TerminalCompletionEvent["source"];
  paneActiveCommand: string | null;
  sessionActiveCommand: string | null;
  commandName: string | null;
}): TerminalCompletionEvent["source"] {
  const inferredSource =
    getCompletionSourceForCommand(params.paneActiveCommand) ??
    getCompletionSourceForCommand(params.commandName) ??
    getCompletionSourceForCommand(params.sessionActiveCommand);

  return inferredSource ?? params.reportedSource;
}

/**
 * Resolve the completing pane. The hook may report a `panelId` (from the pane's
 * `RUNWEAVE_TERMINAL_PANEL_ID` env) or a `tmuxPaneId`; fall back to matching an
 * existing panel record by tmux pane id so pane-as-worker attribution works.
 */
function resolveCompletionPane(
  terminalSessionManager: TerminalSessionManager,
  terminalSessionId: string,
  panelId: string | null,
  tmuxPaneId: string | null,
):
  | { ok: true; panelId: string | null; tmuxPaneId: string | null }
  | {
      ok: false;
      panelId: string | null;
      tmuxPaneId: string | null;
      reason: string;
    } {
  const panels = terminalSessionManager.listPanels(terminalSessionId);
  const byId = panelId
    ? panels.find((panel) => panel.id === panelId) ?? null
    : null;
  const byPane = tmuxPaneId
    ? panels.find((panel) => panel.tmuxPaneId === tmuxPaneId) ?? null
    : null;

  if (panelId) {
    if (!byId) {
      return {
        ok: false,
        panelId,
        tmuxPaneId,
        reason: "unknown_panel_id",
      };
    }
    if (tmuxPaneId && byId.tmuxPaneId !== tmuxPaneId) {
      return {
        ok: false,
        panelId,
        tmuxPaneId,
        reason: "panel_tmux_mismatch",
      };
    }
    return { ok: true, panelId, tmuxPaneId: byId.tmuxPaneId };
  }
  if (tmuxPaneId) {
    return { ok: true, panelId: byPane?.id ?? null, tmuxPaneId };
  }
  return { ok: true, panelId: null, tmuxPaneId: null };
}
