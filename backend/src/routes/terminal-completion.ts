import { Router } from "express";
import { z } from "zod";
import type { TerminalCompletionEvent } from "@browser-viewer/shared";
import type { TerminalCompletionEventStore } from "../terminal/completion-events";
import type { TerminalSessionManager } from "../terminal/manager";

const completionEventSchema = z
  .object({
    terminalSessionId: z.string().trim().min(1),
    source: z.enum(["claude", "codex", "trae", "unknown"]).default("unknown"),
    hookEvent: z.string().trim().min(1),
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
      res.status(503).json({ message: "Terminal completion hook unavailable" });
      return;
    }

    if (req.header("x-runweave-hook-token") !== expectedToken) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const parsed = completionEventSchema.safeParse(req.body);
    if (!parsed.success) {
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
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }

    const event: TerminalCompletionEvent = options.completionEventStore.record(
      {
        terminalSessionId: parsed.data.terminalSessionId,
        source: parsed.data.source,
        hookEvent: parsed.data.hookEvent,
        cwd: parsed.data.cwd ?? null,
      },
      session,
    );
    res.status(202).json({ event });
  });

  return router;
}
