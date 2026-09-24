import { Router, type Response } from "express";
import { z } from "zod";
import type { ScheduledTaskService } from "../scheduled-tasks/service";
import { ScheduledTaskError } from "../scheduled-tasks/errors";

const timezone = z.string().trim().min(1).max(100);
const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), timezone, localTime }).strict(),
  z.object({ kind: z.literal("weekdays"), timezone, localTime }).strict(),
  z
    .object({
      kind: z.literal("weekly"),
      timezone,
      localTime,
      weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    })
    .strict(),
  z
    .object({
      kind: z.literal("once"),
      timezone,
      runAt: z.string().datetime({ offset: true }),
    })
    .strict(),
]);
const provider = z.enum(["codex", "trae", "pi"]);
const configShape = {
  name: z.string().trim().min(1).max(80),
  projectId: z.string().trim().min(1).max(500),
  provider,
  prompt: z.string().trim().min(1).max(12_000),
  model: z.string().trim().min(1).max(200).optional(),
  effort: z.string().trim().min(1).max(100).optional(),
  executionPolicy: z.enum(["sandbox", "auto-review"]).optional(),
  misfirePolicy: z
    .discriminatedUnion("mode", [
      z.object({ mode: z.literal("skip") }).strict(),
      z
        .object({
          mode: z.literal("catch-up-latest"),
          maxDelaySeconds: z
            .number()
            .int()
            .min(3600)
            .max(604800)
            .multipleOf(3600),
        })
        .strict(),
    ]),
  schedule: scheduleSchema,
};
const createTaskSchema = z
  .object({ ...configShape, enabled: z.boolean() })
  .strict();
const updateTaskSchema = z
  .object({
    name: configShape.name.optional(),
    projectId: configShape.projectId.optional(),
    provider: provider.optional(),
    prompt: configShape.prompt.optional(),
    model: z.string().trim().min(1).max(200).nullable().optional(),
    effort: z.string().trim().min(1).max(100).nullable().optional(),
    executionPolicy: configShape.executionPolicy,
    misfirePolicy: configShape.misfirePolicy.optional(),
    schedule: scheduleSchema.optional(),
    enabled: z.boolean().optional(),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
const previewSchema = z.object({ schedule: scheduleSchema }).strict();
const deleteSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
const openSchema = z
  .object({ replaceRepurposedBinding: z.boolean().optional() })
  .strict();
const listSchema = z
  .object({
    parentProjectId: z.string().trim().min(1).optional(),
    projectId: z.string().trim().min(1).optional(),
    q: z.string().max(500).optional(),
    archived: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const paginationSchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const taskParams = z.object({ taskId: z.string().uuid() }).strict();
const runParams = z.object({ runId: z.string().uuid() }).strict();

export function createScheduledTasksRouter(
  service: ScheduledTaskService,
): Router {
  const router = Router();
  router.get("/capabilities", (_req, res) =>
    handle(res, () => service.capabilities()),
  );
  router.post("/preview", (req, res) =>
    handle(res, () => service.preview(previewSchema.parse(req.body).schedule)),
  );
  router.post("/validate-create", (req, res) =>
    handle(res, () => service.validateCreate(createTaskSchema.parse(req.body))),
  );
  router.get("/runs/:runId/output", (req, res) =>
    handle(res, async () => {
      const { runId } = runParams.parse(req.params);
      const query = paginationSchema.pick({ cursor: true }).parse(req.query);
      return service.output(runId, query.cursor);
    }),
  );
  router.get("/runs/:runId", (req, res) =>
    handle(res, () => service.getRun(runParams.parse(req.params).runId)),
  );
  router.post("/runs/:runId/stop", (req, res) =>
    handle(res, () => service.stop(runParams.parse(req.params).runId), 202),
  );
  router.post("/runs/:runId/open-terminal", async (req, res) => {
    await handle(res, async () => {
      const input = openSchema.parse(req.body ?? {});
      const result = await service.openTerminal(
        runParams.parse(req.params).runId,
        input.replaceRepurposedBinding,
      );
      if (result.attachmentState !== "ready") res.status(202);
      return result;
    });
  });
  router.get("/", (req, res) =>
    handle(res, () => service.list(listSchema.parse(req.query))),
  );
  router.post("/", (req, res) =>
    handle(
      res,
      () =>
        service.create(
          createTaskSchema.parse(req.body),
          requireIdempotencyKey(req.headers["idempotency-key"]),
        ),
      201,
    ),
  );
  router.get("/:taskId/runs", (req, res) =>
    handle(res, () => {
      const { taskId } = taskParams.parse(req.params);
      const query = paginationSchema.parse(req.query);
      return service.listRuns(taskId, query.cursor, query.limit);
    }),
  );
  router.post("/:taskId/runs", (req, res) =>
    handle(
      res,
      () => {
        z.object({})
          .strict()
          .parse(req.body ?? {});
        return service.start(
          taskParams.parse(req.params).taskId,
          requireIdempotencyKey(req.headers["idempotency-key"]),
        );
      },
      202,
    ),
  );
  router.get("/:taskId", (req, res) =>
    handle(res, () => service.getTask(taskParams.parse(req.params).taskId)),
  );
  router.patch("/:taskId", (req, res) =>
    handle(res, () =>
      service.update(
        taskParams.parse(req.params).taskId,
        updateTaskSchema.parse(req.body),
      ),
    ),
  );
  router.post("/:taskId/validate-update", (req, res) =>
    handle(res, () =>
      service.validateUpdate(
        taskParams.parse(req.params).taskId,
        updateTaskSchema.parse(req.body),
      ),
    ),
  );
  router.delete("/:taskId", (req, res) =>
    handle(res, () => {
      const body = deleteSchema.parse(req.body);
      return service.remove(
        taskParams.parse(req.params).taskId,
        body.expectedRevision,
      );
    }),
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
      res
        .status(400)
        .json({
          code: "invalid_input",
          message: "Invalid scheduled task request",
          details: error.flatten(),
        });
      return;
    }
    if (error instanceof ScheduledTaskError) {
      res
        .status(error.statusCode)
        .json({
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        });
      return;
    }
    res
      .status(500)
      .json({
        code: "scheduled_task_request_failed",
        message: "Scheduled task request failed",
      });
  }
}

function requireIdempotencyKey(value: string | string[] | undefined): string {
  const key = Array.isArray(value) ? value[0] : value;
  if (!key?.trim() || key.length > 200)
    throw new ScheduledTaskError(
      "invalid_input",
      400,
      "Idempotency-Key header is required",
    );
  return key.trim();
}
