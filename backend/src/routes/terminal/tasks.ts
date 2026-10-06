import type { Router, Response } from "express";
import { z } from "zod";
import { TerminalTaskService, TerminalTaskError } from "../../terminal/tasks/service";
import { TerminalInputBusyError } from "../../terminal/runtime/input-admission";

const key = z.string().trim().min(1).max(160);
const revision = z.number().int().nonnegative();
const schemas = {
  create: z.object({ taskId: key, projectId: key, cwd: z.string().min(1).max(4096), goal: z.string().trim().min(1).max(16000) }).strict(),
  start: z.object({ expectedRevision: revision, commandLine: z.string().trim().min(1).max(4096).optional() }).strict(),
  send: z.object({ expectedRevision: revision, dispatchId: key, text: z.string().min(1).max(64000), delivery: z.enum(["when_idle", "queue"]).default("when_idle") }).strict(),
  control: z.object({ expectedRevision: revision, control: z.enum(["supervisor", "human"]), draftCleared: z.boolean().optional() }).strict(),
  review: z.object({ expectedRevision: revision, reviewId: key, dispatchId: key, outcome: z.enum(["accepted", "changes_requested", "blocked"]), summary: z.string().trim().min(1).max(16000), evidence: z.array(z.string().trim().min(1).max(4096)).max(100) }).strict(),
  interrupt: z.object({ expectedRevision: revision, scope: z.literal("terminal") }).strict(),
};

function failure(res: Response, error: unknown): void {
  const status = error instanceof TerminalTaskError ? error.status : error instanceof TerminalInputBusyError ? 409 : 503;
  res.status(status).json({ code: error instanceof TerminalTaskError ? error.code : "terminal_task_unavailable", message: error instanceof Error ? error.message : "Terminal task unavailable" });
}

export function registerTerminalTaskRoutes(router: Router, service?: TerminalTaskService): void {
  router.get("/tasks", (_req, res) => {
    if (!service) { res.status(503).json({ message: "Terminal task service unavailable" }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.json({ tasks: service.list() });
  });
  router.post("/tasks", async (req, res) => {
    const parsed = schemas.create.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ message: "Invalid task", errors: parsed.error.flatten() }); return; }
    if (!service) { res.status(503).json({ message: "Terminal task service unavailable" }); return; }
    try { res.json(await service.create(parsed.data)); } catch (error) { failure(res, error); }
  });
  router.get("/tasks/:taskId", async (req, res) => {
    const query = z.object({ afterTurnId: key.optional() }).strict().safeParse(req.query);
    if (!query.success) { res.status(400).json({ message: "Invalid observation query" }); return; }
    if (!service) { res.status(503).json({ message: "Terminal task service unavailable" }); return; }
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.observe(req.params.taskId, query.data.afterTurnId)); } catch (error) { failure(res, error); }
  });
  for (const action of ["start", "send", "control", "review", "interrupt"] as const) {
    router.post(`/tasks/:taskId/${action}`, async (req, res) => {
      if (!service) { res.status(503).json({ message: "Terminal task service unavailable" }); return; }
      try {
        // Keep discriminated request validation at the transport boundary.
        switch (action) {
          case "start": res.json(await service.start(req.params.taskId, schemas.start.parse(req.body))); break;
          case "send": res.json(await service.send(req.params.taskId, schemas.send.parse(req.body))); break;
          case "control": res.json(await service.control(req.params.taskId, schemas.control.parse(req.body))); break;
          case "review": res.json(await service.review(req.params.taskId, schemas.review.parse(req.body))); break;
          case "interrupt": res.json(await service.interrupt(req.params.taskId, schemas.interrupt.parse(req.body))); break;
        }
      } catch (error) {
        if (error instanceof z.ZodError) { res.status(400).json({ message: "Invalid task request", errors: error.flatten() }); return; }
        failure(res, error);
      }
    });
  }
}
