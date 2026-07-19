import { Router } from "express";
import type { AttentionService } from "../attention/attention-service";

export function createAttentionRouter(service: AttentionService): Router {
  const router = Router();
  router.get("/slots", async (_request, response, next) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.json(await service.snapshot());
    } catch (error) {
      next(error);
    }
  });
  return router;
}
