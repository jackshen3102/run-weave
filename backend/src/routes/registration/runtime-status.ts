import type { Express, RequestHandler } from "express";
import type { BackendRuntimeStatusService } from "../../runtime-status/service";
import { createRuntimeStatusRouter } from "../runtime-status";

export function registerRuntimeStatusRoutes(
  app: Express,
  requireAuth: RequestHandler,
  status: BackendRuntimeStatusService,
): void {
  app.use(
    "/api/runtime-status",
    requireAuth,
    createRuntimeStatusRouter(status.registry),
  );
}
