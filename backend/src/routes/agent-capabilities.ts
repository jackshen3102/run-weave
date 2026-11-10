import { Router } from "express";
import type { AgentCapabilitiesService } from "../agent-capabilities/service";

/** Mounted behind the Backend's existing login middleware. No client paths. */
export function createAgentCapabilitiesRouter(service: AgentCapabilitiesService): Router {
  const router = Router();
  router.get("/", async (request, response, next) => {
    if (Object.keys(request.query).length || request.body != null && Object.keys(request.body).length) {
      response.status(400).json({ error: "agent_capabilities_parameters_unsupported" });
      return;
    }
    try {
      response.setHeader("Cache-Control", "no-store");
      response.json(await service.getCapabilities());
    } catch (error) { next(error); }
  });
  return router;
}
