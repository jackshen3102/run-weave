import { Router } from "express";
import { z } from "zod";
import type { TerminalEventEnvelope } from "@runweave/shared";
import { logger } from "../logging";
import type { TerminalCompletionEventService } from "../terminal/completion-event-service";
import {
  AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS,
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
  })
  .strict();

export function createInternalTerminalCompletionRouter(options: {
  completionEventService: TerminalCompletionEventService;
  terminalSessionManager: TerminalSessionManager;
  hookToken: string | undefined;
}): Router {
  const router = Router();

  router.post("/", (req, res) => {
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
    const lastAiActiveCommand =
      options.terminalSessionManager.getLastAiActiveCommand(session.id);
    const currentCommandMatches =
      isCompletionSourceAllowedForCommand(
        parsed.data.source,
        session.activeCommand,
      ) ||
      getTerminalSessionAgent(session) === parsed.data.source;
    const now = Date.now();
    const graceCommandMatches =
      session.activeCommand === null &&
      lastAiActiveCommand !== null &&
      lastAiActiveCommand.source === parsed.data.source &&
      lastAiActiveCommand.clearedAt !== null &&
      now - lastAiActiveCommand.clearedAt <=
        AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS;

    if (!currentCommandMatches && !graceCommandMatches) {
      terminalCompletionLogger.info("terminal-completion.ignored", {
        message: "Terminal completion event ignored",
        terminalSessionId: parsed.data.terminalSessionId,
        source: parsed.data.source,
        activeCommand: session.activeCommand,
        lastAiActiveCommand: lastAiActiveCommand?.command ?? null,
        lastAiActiveCommandClearedAt: lastAiActiveCommand?.clearedAt
          ? new Date(lastAiActiveCommand.clearedAt).toISOString()
          : null,
        rawHookEvent,
      });
      res.status(202).json({ event: null, ignored: true });
      return;
    }

    const event: TerminalEventEnvelope =
      options.completionEventService.record(
        {
          terminalSessionId: parsed.data.terminalSessionId,
          source: parsed.data.source,
          completionReason: parsed.data.completionReason ?? "hook_stop",
          commandName: parsed.data.commandName ?? null,
          rawHookEvent,
          cwd: parsed.data.cwd ?? null,
          outboxPath: parsed.data.outboxPath ?? null,
          summary: parsed.data.summary ?? null,
        },
        session,
      );
    terminalCompletionLogger.info("terminal-completion.recorded", {
      message: "Terminal completion event recorded",
      id: event.id,
      terminalSessionId: event.terminalSessionId,
      source: event.kind === "completion" ? event.payload.source : null,
      activeCommand: session.activeCommand,
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
