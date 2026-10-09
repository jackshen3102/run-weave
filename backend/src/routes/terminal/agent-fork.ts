import type { Router } from "express";
import { z } from "zod";
import type { TerminalAgentForkService } from "../../terminal/application/agent-fork";
import { sendTerminalPanelRouteError } from "./panels/common";

export function registerTerminalAgentForkRoutes(router: Router, service: TerminalAgentForkService): void {
  const schema = z.object({ operationId: z.string().uuid(), panelId: z.string().min(1).max(200),
    expectedThreadId: z.string().uuid(), expectedRevision: z.string().min(1).max(1000) }).strict();
  router.get("/session/:id/agent/fork-target", async (req, res) => {
    try { res.json(await service.target(req.params.id)); }
    catch (error) {
      if (!sendTerminalPanelRouteError(res, error)) res.status(503).json({ message: "Codex 会话暂不可读取" });
    }
  });
  router.post("/session/:id/agent/fork", async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ message: "Invalid Fork request" }); return; }
    try { res.status(201).json(await service.fork(req.params.id, parsed.data)); }
    catch (error) {
      if (!sendTerminalPanelRouteError(res, error)) res.status(503).json({ message: "Fork 未确认，请核对终端；不会自动重试" });
    }
  });
}
