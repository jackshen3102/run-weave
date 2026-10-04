import type { Router } from "express";
import { z } from "zod";
import type { TerminalSessionManager } from "../../terminal/manager/manager";
import { readTerminalConversation, TerminalConversationError } from "../../terminal/application/conversation";

const querySchema = z.object({
  panelId: z.string().trim().min(1).max(200).optional(),
  expectedThreadId: z.string().trim().min(1).max(200).optional(),
}).strict();

export function registerTerminalConversationRoutes(router: Router, manager: TerminalSessionManager): void {
  router.get("/session/:id/conversation", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const query = querySchema.safeParse(req.query);
    if (!query.success) { res.status(400).json({ code: "INVALID_REQUEST", message: "会话读取参数无效" }); return; }
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", cancel);
    try {
      const response = await readTerminalConversation(manager, req.params.id, query.data, controller.signal);
      if (!controller.signal.aborted) res.json(response);
    } catch (error) {
      if (!controller.signal.aborted) res.status(error instanceof TerminalConversationError ? error.status : 503).json({
        code: error instanceof TerminalConversationError ? error.code : "CONVERSATION_UNAVAILABLE",
        message: error instanceof TerminalConversationError ? error.message : "会话读取暂不可用",
      });
    } finally { res.off("close", cancel); }
  });
}
