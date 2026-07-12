import type express from "express";
import type { RequestHandler } from "express";
import type { RuntimeServices } from "../bootstrap/runtime-services";
import { createActivityRouter, createInternalActivityRouter } from "./activity";

export function registerActivityRoutes(
  app: express.Express,
  options: {
    services: RuntimeServices;
    requireAuth: RequestHandler;
    requireTunnelAuth: RequestHandler;
    backendInstanceId: string;
    hookToken?: string;
  },
): void {
  app.use(
    "/internal/activity",
    options.requireTunnelAuth,
    createInternalActivityRouter({
      store: options.services.activityStore,
      hookToken: options.hookToken,
    }),
  );
  app.use(
    "/api/activity",
    options.requireTunnelAuth,
    options.requireAuth,
    createActivityRouter({
      queryService: options.services.activityQueryService,
      store: options.services.activityStore,
      authService: options.services.authService,
      backendInstanceId: options.backendInstanceId,
    }),
  );
}
