import type { Express, RequestHandler } from "express";
import type { DevResourcesService } from "../../dev-resources/service";
import { createDevResourcesRouter } from "../dev-resources";

export function registerDevResourcesRoutes(
  app: Express,
  requireAuth: RequestHandler,
  service: DevResourcesService,
): void {
  app.use("/api/dev-resources", requireAuth, createDevResourcesRouter(service));
}
