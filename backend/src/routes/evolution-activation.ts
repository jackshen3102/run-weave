import { Router } from "express";
import { z } from "zod";
import type { EvolutionActivationStore } from "../evolution/activation-store";
import {
  defaultEvolutionScopePolicy,
  validateEvolutionScopePolicy,
} from "../evolution/knowledge/lifecycle";

const scopeParamsSchema = z
  .object({ learningScopeId: z.string().trim().min(1).max(500) })
  .strict();
const traceParamsSchema = z.object({ traceId: z.string().uuid() }).strict();
const traceQuerySchema = z
  .object({
    runId: z.string().trim().min(1).max(500),
    dispatchId: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
const policySchema = z
  .object({
    memoryCanaryEnabled: z.boolean(),
    canaryRate: z.number().min(0).max(1),
    maxInjectedAssets: z.number().int().min(0).max(3),
    maxInjectionBytes: z.number().int().min(0).max(6_000),
    autoPromotion: z.boolean(),
    minimumPromotionGrade: z.enum(["E3", "E4"]),
    minimumPromotionSamples: z.number().int().min(1),
  })
  .strict();

export function createEvolutionActivationRouter(
  store: EvolutionActivationStore,
): Router {
  const router = Router();

  router.get("/candidates", async (request, response) => {
    try {
      const learningScopeId =
        typeof request.query.learningScopeId === "string"
          ? request.query.learningScopeId.trim()
          : "";
      const candidates = await store.listCandidates();
      response.setHeader("Cache-Control", "no-store");
      response.json({
        candidates: learningScopeId
          ? candidates.filter(
              (candidate) => candidate.learningScopeId === learningScopeId,
            )
          : candidates,
      });
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  router.get("/scopes/:learningScopeId/policy", async (request, response) => {
    try {
      const { learningScopeId } = scopeParamsSchema.parse(request.params);
      const policy =
        (await store.getPolicy(learningScopeId)) ??
        defaultEvolutionScopePolicy(learningScopeId);
      response.setHeader("Cache-Control", "no-store");
      response.json(policy);
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  router.put("/scopes/:learningScopeId/policy", async (request, response) => {
    try {
      const { learningScopeId } = scopeParamsSchema.parse(request.params);
      const input = policySchema.parse(request.body);
      const current =
        (await store.getPolicy(learningScopeId)) ??
        defaultEvolutionScopePolicy(learningScopeId);
      const policy = validateEvolutionScopePolicy({
        ...current,
        ...input,
        learningScopeId,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: "authenticated-api",
      });
      await store.putPolicy(policy);
      response.json(policy);
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  router.get("/runtime-traces", async (request, response) => {
    try {
      const { runId, dispatchId } = traceQuerySchema.parse(request.query);
      const traces = await store.listRuntimeTraces(runId);
      response.setHeader("Cache-Control", "no-store");
      response.json({
        traces: dispatchId
          ? traces.filter((trace) => trace.dispatchId === dispatchId)
          : traces,
      });
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  router.get("/runtime-traces/:traceId", async (request, response) => {
    try {
      const { traceId } = traceParamsSchema.parse(request.params);
      const trace = await store.getRuntimeTrace(traceId);
      if (!trace) {
        response.status(404).json({ error: "runtime_trace_not_found" });
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.json(trace);
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  return router;
}

function sendEvolutionError(
  response: {
    status: (code: number) => { json: (body: unknown) => void };
  },
  error: unknown,
): void {
  if (error instanceof z.ZodError) {
    response.status(400).json({
      error: "invalid_evolution_request",
      details: error.flatten(),
    });
    return;
  }
  if (
    error instanceof Error &&
    error.message === "evolution_policy_revision_conflict"
  ) {
    response.status(409).json({ error: error.message });
    return;
  }
  response.status(500).json({ error: "evolution_request_failed" });
}
