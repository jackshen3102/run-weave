import { Router, type Response } from "express";
import { z } from "zod";
import type { ExecutionEfficiencyService } from "../execution-efficiency/service";
import { ExecutionEfficiencyError } from "../execution-efficiency/errors";

const projectId = z.string().trim().min(1).max(500);
const bindingSchema = z
  .object({
    projectId,
    taskId: z.string().uuid(),
    expectedRevision: z.number().int().min(0),
  })
  .strict();
const collectSchema = z
  .object({ projectId, scheduledRunId: z.string().uuid() })
  .strict();
const decisionSchema = z
  .object({
    fingerprint: z.string().length(64),
    verdict: z.enum(["admit", "dismiss"]),
    observationIds: z.array(z.string().length(64)).min(1).max(20),
    title: z.string().trim().max(160),
    admissionReason: z.string().trim().max(2_000),
    hypothesis: z.string().trim().max(2_000),
    causeTags: z.array(z.string().trim().min(1).max(80)).max(8),
    uncertainty: z.string().trim().max(2_000),
    verification: z.string().trim().max(4_000),
    findingId: z.string().uuid().optional(),
  })
  .strict();
const submitSchema = z
  .object({
    evidenceVersion: z.number().int().positive(),
    decisions: z.array(decisionSchema).max(3),
    answers: z
      .array(
        z
          .object({
            findingId: z.string().uuid(),
            note: z.string().trim().min(1).max(4_000),
            observationIds: z.array(z.string().length(64)).max(20).optional(),
          })
          .strict(),
      )
      .max(3)
      .optional(),
  })
  .strict();
const listSchema = z
  .object({
    projectId,
    dimension: z.enum(["duration", "tokens"]).optional(),
    status: z
      .enum(["pending", "processing", "resolved", "deferred", "dismissed"])
      .optional(),
    q: z.string().max(500).optional(),
    cursor: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const eventSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    action: z.enum([
      "start-processing",
      "resolve",
      "defer",
      "dismiss",
      "reopen",
      "add-note",
      "ask-analysis",
      "add-evidence",
    ]),
    note: z.string().trim().min(1).max(4_000),
    verification: z.string().trim().max(4_000).optional(),
    confirmed: z.boolean().optional(),
    observationIds: z.array(z.string().length(64)).max(20).optional(),
  })
  .strict();

export function createExecutionEfficiencyRouter(
  service: ExecutionEfficiencyService,
): Router {
  const router = Router();
  router.get("/status", (req, res) =>
    handle(res, () =>
      service.status(z.object({ projectId }).strict().parse(req.query).projectId),
    ),
  );
  router.put("/binding", (req, res) =>
    handle(res, () => service.bind(bindingSchema.parse(req.body))),
  );
  router.post("/collections", (req, res) =>
    handle(
      res,
      () =>
        service.collect(
          collectSchema.parse(req.body),
          requireIdempotencyKey(req.headers["idempotency-key"]),
        ),
      201,
    ),
  );
  router.post("/analyses/:analysisId/result", (req, res) =>
    handle(res, () =>
      service.submit(
        z.string().uuid().parse(req.params.analysisId),
        submitSchema.parse(req.body),
        requireIdempotencyKey(req.headers["idempotency-key"]),
      ),
    ),
  );
  router.get("/findings", (req, res) =>
    handle(res, () => service.listFindings(listSchema.parse(req.query))),
  );
  router.get("/findings/:findingId", (req, res) =>
    handle(res, () =>
      service.getFinding(z.string().uuid().parse(req.params.findingId)),
    ),
  );
  router.post("/findings/:findingId/events", (req, res) =>
    handle(res, () =>
      service.addFindingEvent(
        z.string().uuid().parse(req.params.findingId),
        eventSchema.parse(req.body),
        requireIdempotencyKey(req.headers["idempotency-key"]),
      ),
    ),
  );
  return router;
}

async function handle(
  res: Response,
  action: () => unknown | Promise<unknown>,
  status = 200,
): Promise<void> {
  try {
    res.status(status).json(await action());
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        code: "invalid_input",
        message: "Invalid execution efficiency request",
        details: error.flatten(),
      });
      return;
    }
    if (error instanceof ExecutionEfficiencyError) {
      res.status(error.statusCode).json({
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
      return;
    }
    res.status(500).json({
      code: "execution_efficiency_request_failed",
      message: "Execution efficiency request failed",
    });
  }
}

function requireIdempotencyKey(value: string | string[] | undefined): string {
  const key = Array.isArray(value) ? value[0] : value;
  if (!key?.trim() || key.length > 200)
    throw new ExecutionEfficiencyError(
      "invalid_input",
      400,
      "Idempotency-Key header is required",
    );
  return key.trim();
}
