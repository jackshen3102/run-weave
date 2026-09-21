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

export function createExperienceRouter(
  service: ExperienceService,
  learning?: ExperienceLearningRuntime,
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
