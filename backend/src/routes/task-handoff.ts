import { Router } from "express";
import { z } from "zod";
import type { TaskHandoffService } from "../task-handoff/service";

const targetSchema = z
  .object({ panelId: z.string().min(1).max(200).nullable().optional() })
  .strict();
const editSchema = z
  .object({
    panelId: z.string().min(1).max(200).nullable(),
    threadId: z.string().min(1).max(200),
    revision: z.number().int().positive(),
    goal: z.string().trim().min(1).max(1000),
  })
  .strict();
export function createTaskHandoffRouter(service: TaskHandoffService): Router {
  const router = Router();
  router.get("/:id", async (req, res, next) => {
    const parsed = targetSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid query" });
      return;
    }
    try {
      res.json(await service.get(req.params.id, parsed.data.panelId));
    } catch (error) {
      next(error);
    }
  });
  router.post("/:id/refresh", async (req, res, next) => {
    const parsed = targetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request" });
      return;
    }
    try {
      res.json(await service.get(req.params.id, parsed.data.panelId, true));
    } catch (error) {
      next(error);
    }
  });
  router.patch("/:id", async (req, res) => {
    const parsed = editSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request" });
      return;
    }
    try {
      res.json(
        await service.edit(
          {
            terminalSessionId: req.params.id,
            panelId: parsed.data.panelId,
            threadId: parsed.data.threadId,
          },
          parsed.data.revision,
          parsed.data.goal,
        ),
      );
    } catch (error) {
      res
        .status(409)
        .json({ message: error instanceof Error ? error.message : "保存失败" });
    }
  });
  return router;
}
