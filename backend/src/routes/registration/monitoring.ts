import type { Express, RequestHandler } from "express";
import type { RuntimeServices } from "../../bootstrap/runtime-services-contract";
import { registerRuntimeStatusRoutes } from "./runtime-status";
import { registerDevResourcesRoutes } from "./dev-resources";

export function registerMonitoringRoutes(
  app: Express,
  requireAuth: RequestHandler,
  services: Pick<RuntimeServices, "runtimeStatus" | "devResources">,
): void {
  registerRuntimeStatusRoutes(app, requireAuth, services.runtimeStatus);
  registerDevResourcesRoutes(app, requireAuth, services.devResources);
}
