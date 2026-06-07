import { Router } from "express";
import { z } from "zod";
import type { TerminalCompletionEvent } from "@browser-viewer/shared";
import type { TerminalCompletionEventStore } from "../terminal/completion-events";
import type { TerminalSessionManager } from "../terminal/manager";

const completionReasonEnum = z.enum(["hook_stop", "notify", "ai_process_exit", "manual"]);

const completionEventSchema = z
  .object({
    terminalSessionId: z.string().trim().min(1),
    source: z.enum(["claude", "codex", "trae", "unknown"]).default("unknown"),
    completionReason: completionReasonEnum.optional(),
    commandName: z.string().trim().min(1).nullable().optional(),
    rawHookEvent: z.string().trim().min(1).nullable().optional(),
    // deprecated: accepted for backward compat, mapped to rawHookEvent
    hookEvent: z.string().trim().min(1).optional(),
    cwd: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

export function createInternalTerminalCompletionRouter(options: {
  completionEventStore: TerminalCompletionEventStore;
  terminalSessionManager: TerminalSessionManager;
  hookToken: string | undefined;
}): Router {
  const router = Router();

  router.post("/", (req, res) => {
    const expectedToken = options.hookToken;
    if (!expectedToken) {
      console.warn("[viewer-be] terminal-completion: hook unavailable (no token)");
      res.status(503).json({ message: "Terminal completion hook unavailable" });
      return;
    }

    if (req.header("x-runweave-hook-token") !== expectedToken) {
      console.warn("[viewer-be] terminal-completion: bad hook token");
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const parsed = completionEventSchema.safeParse(req.body);
    if (!parsed.success) {
      console.warn("[viewer-be] terminal-completion: invalid body", {
        body: req.body,
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
      console.warn("[viewer-be] terminal-completion: session not found", {
        terminalSessionId: parsed.data.terminalSessionId,
      });
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }

    // Strict gate: only light up the green dot when the (source, activeCommand)
    // pair matches a known AI CLI we support end-to-end. Late-arriving Stop
    // hooks (CLI already exited) and unknown sources are ignored on purpose.
    const allowedActiveCommandsBySource: Record<string, ReadonlySet<string>> = {
      codex: new Set(["codex"]),
      trae: new Set(["trae", "traex", "traecli"]),
    };
    const allowedActiveCommands = allowedActiveCommandsBySource[parsed.data.source];
    if (
      !allowedActiveCommands ||
      !session.activeCommand ||
      !allowedActiveCommands.has(session.activeCommand)
    ) {
      console.info("[viewer-be] terminal-completion: ignored", {
        terminalSessionId: parsed.data.terminalSessionId,
        source: parsed.data.source,
        activeCommand: session.activeCommand,
        rawHookEvent: parsed.data.rawHookEvent ?? parsed.data.hookEvent ?? null,
      });
      res.status(202).json({ event: null, ignored: true });
      return;
    }

    const event: TerminalCompletionEvent = options.completionEventStore.record(
      {
        terminalSessionId: parsed.data.terminalSessionId,
        source: parsed.data.source,
        completionReason: parsed.data.completionReason ?? "hook_stop",
        commandName: parsed.data.commandName ?? null,
        rawHookEvent: parsed.data.rawHookEvent ?? parsed.data.hookEvent ?? null,
        cwd: parsed.data.cwd ?? null,
      },
      session,
    );
    console.info("[viewer-be] terminal-completion: recorded", {
      id: event.id,
      terminalSessionId: event.terminalSessionId,
      source: event.source,
      activeCommand: session.activeCommand,
    });
    res.status(202).json({ event });
  });

  return router;
}
