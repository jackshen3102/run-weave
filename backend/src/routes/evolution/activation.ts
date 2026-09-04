import { Router } from "express";
import { z } from "zod";
import type { EvolutionActivationStore } from "../../evolution/activation-store";
import {
  authorizeMemoryCanary,
  defaultEvolutionScopePolicy,
  retireCandidate,
  validateEvolutionScopePolicy,
} from "../../evolution/knowledge/lifecycle";

const candidateParamsSchema = z
  .object({ candidateId: z.string().trim().min(1).max(200) })
  .strict();
const scopeParamsSchema = z
  .object({ learningScopeId: z.string().trim().min(1).max(500) })
  .strict();
const traceParamsSchema = z.object({ traceId: z.string().uuid() }).strict();
const traceQuerySchema = z
  .object({
    runId: z.string().trim().min(1).max(500).optional(),
    learningScopeId: z.string().trim().min(1).max(500).optional(),
    dispatchId: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
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
const retireCandidateSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
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

  router.get("/candidates/:candidateId", async (request, response) => {
    try {
      const { candidateId } = candidateParamsSchema.parse(request.params);
      const candidate = (await store.listCandidates()).find(
        (item) => item.assetId === candidateId,
      );
      if (!candidate) {
        response.status(404).json({ error: "evolution_candidate_not_found" });
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.json(candidate);
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  router.post(
    "/candidates/:candidateId/canary",
    async (request, response) => {
      try {
        const { candidateId } = candidateParamsSchema.parse(request.params);
        const candidate = (await store.listCandidates()).find(
          (item) => item.assetId === candidateId,
        );
        if (!candidate) {
          response.status(404).json({ error: "evolution_candidate_not_found" });
          return;
        }
        if (candidate.lifecycle === "canary") {
          response.json(candidate);
          return;
        }
        const policy =
          (await store.getPolicy(candidate.learningScopeId)) ??
          defaultEvolutionScopePolicy(candidate.learningScopeId);
        const decision = authorizeMemoryCanary(
          candidate,
          policy,
          new Date().toISOString(),
        );
        if (!decision.changed) {
          response.status(409).json({ error: decision.reason });
          return;
        }
        await store.putCandidate(decision.candidate);
        response.json(decision.candidate);
      } catch (error) {
        sendEvolutionError(response, error);
      }
    },
  );

  router.post(
    "/candidates/:candidateId/retire",
    async (request, response) => {
      try {
        const { candidateId } = candidateParamsSchema.parse(request.params);
        const { reason } = retireCandidateSchema.parse(request.body);
        const candidate = (await store.listCandidates()).find(
          (item) => item.assetId === candidateId,
        );
        if (!candidate) {
          response.status(404).json({ error: "evolution_candidate_not_found" });
          return;
        }
        if (candidate.lifecycle === "retired") {
          response.json(candidate);
          return;
        }
        const decision = retireCandidate(
          candidate,
          reason,
          new Date().toISOString(),
          "authenticated-api",
        );
        if (!decision.changed) {
          response.status(409).json({ error: decision.reason });
          return;
        }
        await store.putCandidate(decision.candidate);
        response.json(decision.candidate);
      } catch (error) {
        sendEvolutionError(response, error);
      }
    },
  );

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
      const { runId, learningScopeId, dispatchId, limit } =
        traceQuerySchema.parse(request.query);
      const traces = runId
        ? await store.listRuntimeTraces(runId)
        : await store.listRecentRuntimeTraces(learningScopeId, limit);
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
  if (
    error instanceof Error &&
    error.message === "evolution_candidate_not_found"
  ) {
    response.status(404).json({ error: error.message });
    return;
  }
  response.status(500).json({ error: "evolution_request_failed" });
}
