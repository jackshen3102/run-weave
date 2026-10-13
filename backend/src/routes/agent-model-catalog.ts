import { Router } from "express";
import type { AgentModelCatalogService } from "../agent-model-catalog/service";

export function createAgentModelCatalogRouter(
  service: AgentModelCatalogService,
): Router {
  const router = Router();
  router.get("/", async (_request, response, next) => {
    try {
      response.json(await service.getCatalogs());
    } catch (error) {
      next(error);
    }
  });
  return router;
}
