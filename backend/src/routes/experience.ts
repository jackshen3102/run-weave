import type { ExperienceLearningRuntime } from "../experience/learning-runtime";
import { Router } from "express";
import { z } from "zod";
import { ExperienceError, type ExperienceService } from "../experience/service";
import {
  cwdSchema,
  draftSchema,
  experienceIdSchema,
  feedbackSchema,
} from "../experience/schema";
import { isLocalDirectHttpRequest } from "../server/local-request";
import type { EvolutionRepositoryScopes } from "../evolution/repository-scope";

export function createExperienceRouter(
  service: ExperienceService,
  learning?: ExperienceLearningRuntime,
  repositories?: Pick<EvolutionRepositoryScopes, "list"> | null,
): Router {
  const router = Router();
  router.use((request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    if (!isLocalDirectHttpRequest(request)) {
      response.status(403).json({ error: "experience_local_request_required" });
      return;
    }
    next();
  });
  const repositoryIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
  const kindSchema = z.enum(["records", "revisions", "candidates", "jobs"]);
  const policySchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u);
  const registeredRepository = async (id: string) => {
    if (!repositories) throw new ExperienceError("experience_repository_registry_unavailable", 503);
    const repository = (await repositories.list(true)).find(item => item.repositoryId === id);
    if (!repository) throw new ExperienceError("experience_repository_not_registered", 404);
    return repository;
  };
  router.get("/maintenance/:repositoryId", async (request, response, next) => {
    try {
      const id = repositoryIdSchema.parse(request.params.repositoryId);
      const query = z.object({ kind: kindSchema, policy: policySchema,
        pendingOnly: z.enum(["true", "false"]).default("false"),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().min(1).max(4096).optional() }).strict().parse(request.query);
      const repository = await registeredRepository(id);
      response.json(await service.maintenanceQueue(id, repository.available === true, query.kind, query.policy, query.pendingOnly === "true", query.limit, query.cursor));
    } catch (error) { next(error); }
  });
  router.post("/maintenance/:repositoryId/reviews", async (request, response, next) => {
    try {
      const id = repositoryIdSchema.parse(request.params.repositoryId);
      const input = z.object({ requestId: z.string().uuid(), policy: policySchema, kind: kindSchema,
        itemId: z.string().min(1).max(256), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/u),
        expectedReviewId: z.string().uuid().nullable(), decision: z.enum(["reviewed", "deferred"]),
        reason: z.string().trim().min(1).max(2000), blocker: policySchema.nullable(),
      }).strict().refine(value => value.decision === "deferred" ? value.blocker !== null : value.blocker === null).parse(request.body);
      const repository = await registeredRepository(id);
      response.json(await service.saveMaintenanceReview(id, repository.available === true, input));
    } catch (error) { next(error); }
  });
  router.get("/maintenance/:repositoryId/reviews/:requestId", async (request, response, next) => {
    try {
      const id = repositoryIdSchema.parse(request.params.repositoryId);
      const requestId = z.string().uuid().parse(request.params.requestId);
      await registeredRepository(id);
      response.json(service.maintenanceReview(id, requestId));
    } catch (error) { next(error); }
  });
  router.get("/catalog/:repositoryId", async (request, response, next) => {
    try {
      const repositoryId = z.string().regex(/^[a-f0-9]{64}$/u).parse(request.params.repositoryId);
      const query = z.object({
        kind: z.enum(["records", "revisions", "candidates", "jobs"]),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().min(1).max(1024).optional(),
      }).strict().parse(request.query);
      if (!repositories) throw new ExperienceError("experience_repository_registry_unavailable", 503);
      const repository = (await repositories.list(true)).find(item => item.repositoryId === repositoryId);
      if (!repository) throw new ExperienceError("experience_repository_not_registered", 404);
      response.json(service.catalog(repositoryId, repository.available === true, query.kind, query.limit, query.cursor));
    } catch (error) { next(error); }
  });
  router.get("/candidates/:id", async (request, response, next) => {
    try {
      response.json(await service.candidate(cwdSchema.parse(request.query.cwd),
        z.string().regex(/^[a-f0-9]{64}$/u).parse(request.params.id)));
    } catch (error) { next(error); }
  });
  router.post("/candidates/:id/retire", async (request, response, next) => {
    try {
      const input = z.object({ cwd: cwdSchema, expectedVersion: z.string().regex(/^[a-f0-9]{64}$/u),
        reason: z.string().trim().min(1).max(2000) }).strict().parse(request.body);
      const id = z.string().regex(/^[a-f0-9]{64}$/u).parse(request.params.id);
      response.json(await service.retireCandidate(input.cwd, id, input.expectedVersion, input.reason));
    } catch (error) { next(error); }
  });
  router.get("/diagnose", async (request, response, next) => {
    try {
      const input = z
        .object({
          cwd: cwdSchema,
          query: z.string().trim().min(2).max(4000).optional(),
        })
        .strict()
        .parse(request.query);
      response.json(await service.diagnose(input.cwd, input.query));
    } catch (error) {
      next(error);
    }
  });
  router.get("/status", async (request, response, next) => {
    try {
      if (!learning)
        throw new ExperienceError("experience_learning_unavailable", 503);
      response.json(await learning.status(cwdSchema.parse(request.query.cwd)));
    } catch (error) {
      next(error);
    }
  });
  router.post("/retry", async (request, response, next) => {
    try {
      if (!learning)
        throw new ExperienceError("experience_learning_unavailable", 503);
      const input = z
        .object({ cwd: cwdSchema, jobId: z.string().regex(/^[a-f0-9]{64}$/u) })
        .strict()
        .parse(request.body);
      await learning.retry(input.cwd, input.jobId);
      response.json({ queued: true });
    } catch (error) {
      next(error);
    }
  });
  router.post("/search", async (request, response, next) => {
    try {
      const input = z
        .object({ cwd: cwdSchema, query: z.string().trim().min(2).max(4000) })
        .strict()
        .parse(request.body);
      response.json(await service.search(input.cwd, input.query));
    } catch (error) {
      next(error);
    }
  });
  router.get("/records/:id", async (request, response, next) => {
    try {
      response.json(
        await service.show(
          cwdSchema.parse(request.query.cwd),
          experienceIdSchema.parse(request.params.id),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  router.post("/records", async (request, response, next) => {
    try {
      const input = z
        .object({
          cwd: cwdSchema,
          record: draftSchema,
          expectedRevision: z.string().uuid().optional(),
        })
        .strict()
        .parse(request.body);
      response
        .status(201)
        .json(
          await service.save(input.cwd, input.record, input.expectedRevision),
        );
    } catch (error) {
      next(error);
    }
  });
  router.post("/feedback", async (request, response, next) => {
    try {
      const input = z
        .object({ cwd: cwdSchema, feedback: feedbackSchema })
        .strict()
        .parse(request.body);
      response
        .status(201)
        .json(await service.feedback(input.cwd, input.feedback));
    } catch (error) {
      next(error);
    }
  });
  router.get("/feedback", async (request, response, next) => {
    try {
      response.json(await service.history(cwdSchema.parse(request.query.cwd)));
    } catch (error) {
      next(error);
    }
  });
  router.use(((error, _request, response, _next) => {
    void _next; // Express identifies error middleware by its four-argument arity.
    if (error instanceof z.ZodError) {
      response.status(400).json({
        error: "invalid_experience_request",
        details: error.flatten(),
      });
    } else if (error instanceof ExperienceError) {
      response.status(error.status).json({ error: error.message });
    } else {
      response.status(500).json({ error: "experience_request_failed" });
    }
  }) as import("express").ErrorRequestHandler);
  return router;
}
