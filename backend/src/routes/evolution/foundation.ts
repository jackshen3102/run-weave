import { Router } from "express";
import { z } from "zod";
import type { EvolutionService } from "../../evolution/service";

const profileSchema = z.enum(["quick", "standard", "deep"]);
const providerPolicySchema = z.enum(["auto", "codex", "trae", "mixed"]);
const runStageSchema = z.enum([
  "queued",
  "snapshotting",
  "segmenting",
  "independent_analysis",
  "cross_questioning",
  "adjudicating",
  "novelty_check",
  "validating",
  "completed",
  "no_material_novelty",
  "partial",
  "failed",
  "cancelled",
  "blocked",
]);
const budgetSchema = z
  .object({
    maxAgents: z.number().int().min(1).max(3).optional(),
    maxModelTurns: z.number().int().min(1).max(100).optional(),
    maxWallTimeMs: z
      .number()
      .int()
      .min(1_000)
      .max(3 * 60 * 60_000)
      .optional(),
    maxContextBytes: z.number().int().min(1_000).max(10_000_000).optional(),
    maxToolCalls: z.number().int().min(1).max(1_000).optional(),
    maxReplays: z.number().int().min(0).max(10).optional(),
  })
  .strict();
const dataRangeSchema = z
  .object({
    afterWatermark: z.string().trim().min(1).max(2_000).nullable().optional(),
    atOrBefore: z.string().datetime().optional(),
  })
  .strict();
const reflectionScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("global") }).strict(),
  z
    .object({
      type: z.literal("repository"),
      cwd: z.string().min(1).max(4096).optional(),
      repositoryId: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("project"),
      projectId: z.string().trim().min(1).max(500),
    })
    .strict(),
]);
const createRunSchema = z
  .object({
    projectId: z.string().trim().min(1).max(500).optional(),
    scope: reflectionScopeSchema.optional(),
    profile: profileSchema.optional(),
    providerPolicy: providerPolicySchema.optional(),
    budget: budgetSchema.optional(),
    dataRange: dataRangeSchema.optional(),
  })
  .strict()
  .refine(
    (value) => (value.projectId === undefined) !== (value.scope === undefined),
    "evolution_scope_required",
  );
const listRunsQuerySchema = z
  .object({
    learningScopeId: z.string().trim().min(1).max(500).optional(),
    stage: runStageSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
const runParamsSchema = z.object({ runId: z.string().uuid() }).strict();
const insightParamsSchema = z
  .object({ insightId: z.string().trim().min(1).max(200) })
  .strict();
const insightQuerySchema = z
  .object({
    learningScopeId: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
const scheduleParamsSchema = z
  .object({ scheduleId: z.string().uuid() })
  .strict();
const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(isValidTimezone, "invalid_timezone");
const createScheduleSchema = z
  .object({
    projectId: z.string().trim().min(1).max(500).optional(),
    scope: reflectionScopeSchema.optional(),
    name: z.string().trim().min(1).max(200),
    cronExpression: z.string().trim().min(1).max(200),
    timezone: timezoneSchema,
    enabled: z.boolean().optional(),
    profile: profileSchema.optional(),
    providerPolicy: providerPolicySchema.optional(),
    budget: budgetSchema.optional(),
    dataWindow: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
const updateScheduleSchema = createScheduleSchema
  .omit({ projectId: true, scope: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "empty_schedule_update");
const listSchedulesQuerySchema = z
  .object({
    learningScopeId: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export function createEvolutionFoundationRouter(
  service: EvolutionService,
): Router {
  const router = Router();
  router.get("/scopes", async (_request, response) => {
    try {
      if (!service.repositories) throw new Error("evolution_unavailable");
      response.json({ repositories: await service.repositories.list() });
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });
  router.get("/scopes/resolve", async (request, response) => {
    try {
      if (!service.repositories) throw new Error("evolution_unavailable");
      const input = z
        .object({
          cwd: z.string().min(1).optional(),
          learningScopeId: z.string().min(1).optional(),
        })
        .strict()
        .parse(request.query);
      if (input.cwd && input.learningScopeId)
        throw new Error("evolution_scope_conflict");
      if (input.cwd)
        response.json(
          await service.repositories.resolve({
            scope: { type: "repository", cwd: input.cwd },
          }),
        );
      else if (input.learningScopeId)
        response.json({
          repositoryId: await service.repositories.queryScope(
            input.learningScopeId,
          ),
        });
      else throw new Error("evolution_repository_required");
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });
  router.post("/reflection-batches", async (request, response) => {
    try {
      const { idempotencyKey } = z
        .object({ idempotencyKey: z.string().uuid() })
        .strict()
        .parse(request.body);
      response
        .status(201)
        .json(
          await service.createReflectionBatch(
            idempotencyKey,
            "authenticated-api",
          ),
        );
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  router.post("/runs", async (request, response) => {
    try {
      const input = createRunSchema.parse(request.body);
      const run = await service.createManualRun(input, "authenticated-api");
      response.status(201).json(run);
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  router.get("/runs", async (request, response) => {
    try {
      const query = listRunsQuerySchema.parse(request.query);
      if (query.learningScopeId && service.repositories)
        query.learningScopeId = await service.repositories.queryScope(
          query.learningScopeId,
        );
      response.setHeader("Cache-Control", "no-store");
      response.json({ runs: await service.listRuns(query) });
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  router.get("/runs/:runId", async (request, response) => {
    try {
      const { runId } = runParamsSchema.parse(request.params);
      const run = await service.getRun(runId);
      if (!run) {
        response.status(404).json({ error: "evolution_run_not_found" });
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.json(run);
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  router.post("/runs/:runId/cancel", async (request, response) => {
    try {
      const { runId } = runParamsSchema.parse(request.params);
      response.json(await service.cancelRun(runId));
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  router.get("/runs/:runId/artifacts", async (request, response) => {
    try {
      const { runId } = runParamsSchema.parse(request.params);
      response.setHeader("Cache-Control", "no-store");
      response.json(await service.getRunArtifacts(runId));
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  router.post("/runs/:runId/retry", async (request, response) => {
    try {
      const { runId } = runParamsSchema.parse(request.params);
      const run = await service.retryRun(runId, "authenticated-api");
      response.status(201).json(run);
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  router.get("/providers", async (_request, response) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.json({
        runtimeAvailable: service.isAvailable(),
        providers: await service.listProviders(),
      });
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  router.get("/insights", async (request, response) => {
    try {
      let { learningScopeId } = insightQuerySchema.parse(request.query);
      if (learningScopeId && service.repositories)
        learningScopeId =
          await service.repositories.queryScope(learningScopeId);
      response.setHeader("Cache-Control", "no-store");
      response.json({
        insights: await service.listInsights(learningScopeId),
      });
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  router.get("/insights/:insightId", async (request, response) => {
    try {
      const { insightId } = insightParamsSchema.parse(request.params);
      const insight = await service.getInsight(insightId);
      if (!insight) {
        response.status(404).json({ error: "evolution_insight_not_found" });
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.json(insight);
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  router.post("/schedules", async (request, response) => {
    try {
      const input = createScheduleSchema.parse(request.body);
      const schedule = await service.createSchedule(input);
      response.status(201).json(schedule);
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  router.get("/schedules", async (request, response) => {
    try {
      let { learningScopeId } = listSchedulesQuerySchema.parse(request.query);
      if (learningScopeId && service.repositories)
        learningScopeId =
          await service.repositories.queryScope(learningScopeId);
      response.setHeader("Cache-Control", "no-store");
      response.json({
        schedules: await service.listSchedules(learningScopeId),
      });
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  router.patch("/schedules/:scheduleId", async (request, response) => {
    try {
      const { scheduleId } = scheduleParamsSchema.parse(request.params);
      const input = updateScheduleSchema.parse(request.body);
      response.json(await service.updateSchedule(scheduleId, input));
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  router.delete("/schedules/:scheduleId", async (request, response) => {
    try {
      const { scheduleId } = scheduleParamsSchema.parse(request.params);
      await service.deleteSchedule(scheduleId);
      response.status(204).end();
    } catch (error) {
      sendEvolutionError(response, error);
    }
  });

  return router;
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function sendEvolutionError(
  response: {
    status: (code: number) => {
      json: (body: unknown) => void;
    };
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
  const message =
    error instanceof Error ? error.message : "evolution_request_failed";
  if (message === "evolution_unavailable") {
    response.status(503).json({ error: message });
    return;
  }
  if (
    message === "evolution_run_not_found" ||
    message === "evolution_schedule_not_found" ||
    message === "evolution_insight_not_found"
  ) {
    response.status(404).json({ error: message });
    return;
  }
  if (message === "evolution_run_not_retryable") {
    response.status(409).json({ error: message });
    return;
  }
  if (
    message === "evolution_schedule_cron_invalid" ||
    message === "evolution_schedule_timezone_invalid" ||
    message === "evolution_schedule_next_due_not_found" ||
    message === "evolution_project_id_required"
  ) {
    response.status(400).json({ error: message });
    return;
  }
  if (
    message === "evolution_scope_conflict" ||
    message === "evolution_batch_repository_limit" ||
    message.startsWith("evolution_repository_") ||
    message === "evolution_global_requires_reflection_batch" ||
    message.startsWith("repository_") ||
    message === "evolution_project_not_found"
  ) {
    response.status(409).json({ error: message });
    return;
  }
  response.status(500).json({ error: "evolution_request_failed" });
}
