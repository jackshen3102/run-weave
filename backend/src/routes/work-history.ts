import { Router } from "express";
import { z } from "zod";
import type { WorkHistoryService } from "../work-history/work-history-service";

const listQuerySchema = z
  .object({
    search: z.string().trim().max(256).optional(),
    cursor: z.string().trim().max(2_048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const terminalDetailQuerySchema = z
  .object({
    activityCursor: z.string().trim().max(2_048).optional(),
    asOfActivityOffset: z.coerce.number().int().min(0).optional(),
    threadCursor: z.string().trim().max(2_048).optional(),
    includeActivity: z.enum(["true", "false"]).optional(),
    includeThreadDetails: z.enum(["true", "false"]).optional(),
  })
  .strict();

const runDetailQuerySchema = terminalDetailQuerySchema.pick({
  activityCursor: true,
  asOfActivityOffset: true,
});

export function createWorkHistoryRouter(service: WorkHistoryService): Router {
  const router = Router();

  router.get("/terminals", async (request, response, next) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ message: "Invalid request query" });
      return;
    }
    try {
      response.json(await service.listTerminals(parsed.data));
    } catch (error) {
      next(error);
    }
  });

  router.get("/terminals/:terminalSessionId", async (request, response, next) => {
    const parsed = terminalDetailQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ message: "Invalid request query" });
      return;
    }
    try {
      const detail = await service.getTerminal(request.params.terminalSessionId, {
        activityCursor: parsed.data.activityCursor,
        asOfActivityOffset: parsed.data.asOfActivityOffset,
        threadCursor: parsed.data.threadCursor,
        includeActivity: parsed.data.includeActivity !== "false",
        includeThreadDetails: parsed.data.includeThreadDetails !== "false",
      });
      if (!detail) {
        response.status(404).json({ message: "Terminal archive not found" });
        return;
      }
      response.json(detail);
    } catch (error) {
      next(error);
    }
  });

  router.get("/runs", async (request, response, next) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ message: "Invalid request query" });
      return;
    }
    try {
      response.json(await service.listRuns(parsed.data));
    } catch (error) {
      next(error);
    }
  });

  router.get("/runs/:runId", async (request, response, next) => {
    const parsed = runDetailQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ message: "Invalid request query" });
      return;
    }
    try {
      const detail = await service.getRun(request.params.runId, parsed.data);
      if (!detail) {
        response.status(404).json({ message: "Agent Team archive not found" });
        return;
      }
      response.json(detail);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
