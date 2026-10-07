import type { Express, RequestHandler } from "express";
import type { RuntimeServices } from "../../bootstrap/runtime-services-contract";
import { createTaskHandoffRouter } from "../task-handoff";
import { registerTaskSupervisionRoutes } from "../task-supervision";
export function registerTerminalTaskRoutes(app: Express, services: Pick<RuntimeServices, "taskHandoffService" | "taskSupervisionService">, requireAuth: RequestHandler, requireTunnelAuth: RequestHandler) {
  app.use("/api/task-handoff", requireAuth, createTaskHandoffRouter(services.taskHandoffService));
  registerTaskSupervisionRoutes(app, services.taskSupervisionService, requireAuth, requireTunnelAuth);
}
