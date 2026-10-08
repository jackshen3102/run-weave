import { Router } from "express";
import { z } from "zod";
import {
  SupervisionError,
  type TaskSupervisionService,
} from "../task-supervision/service";

const id = z.string().min(1).max(200);
const target = z
  .object({
    terminalSessionId: id,
    panelId: id,
    threadId: z.string().max(200),
    executorGeneration: id,
  })
  .strict();
const start = z
  .object({
    target,
    taskStartMessageId: z.string().max(200),
    goal: z.string().trim().max(8000),
    planPaths: z.array(z.string().min(1).max(1000)).max(10),
    requestId: z.string().uuid(),
    replacesWatchId: z.string().uuid().optional(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict();
const change = z
  .object({
    action: z.enum(["pause", "resume", "update-context", "retry-continuation"]),
    expectedRevision: z.number().int().positive(),
    goal: z.string().trim().min(1).max(8000).optional(),
    decisionId: z.string().uuid().optional(),
    expectedInputVersion: z.string().uuid().optional(),
  })
  .strict();
const hook = z
  .object({
    target,
    event: z.enum([
      "SessionStart",
      "UserPromptSubmit",
      "Interrupt",
      "Stop",
      "PermissionRequest",
      "PreToolUse",
      "PostToolUse",
    ]),
    toolName: z.string().max(200).optional(),
    hookVersion: z.literal(1),
    codexVersion: z.string().max(100),
    executionModel: z.string().min(1).max(200).optional(),
    executionConfig: z
      .object({
        binary: z.string().min(1).max(2000),
        home: z.string().min(1).max(2000),
        cwd: z.string().min(1).max(2000),
        args: z.array(z.string().max(16000)).max(100),
      })
      .strict()
      .optional(),
    rawTurnId: id.optional(),
    reply: z.string().max(1_000_000).optional(),
    prompt: z.string().max(1_000_000).optional(),
    deadline: z.number().int().positive(),
  })
  .strict();
function report(error: unknown, res: import("express").Response) {
  res.status(error instanceof SupervisionError ? error.status : 503).json({
    message: error instanceof Error ? error.message : "监听服务不可用。",
  });
}
export function createTaskSupervisionRouter(service: TaskSupervisionService) {
  const router = Router();
  router.get("/", async (req, res) => {
    const parsed = z
      .object({
        terminalSessionId: id,
        panelId: id.optional(),
        expectedThreadId: id.optional(),
      })
      .strict()
      .safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid query" });
      return;
    }
    try {
      res.json(
        await service.discover(
          parsed.data.terminalSessionId,
          parsed.data.panelId,
          parsed.data.expectedThreadId,
        ),
      );
    } catch (error) {
      report(error, res);
    }
  });
  router.post("/", async (req, res) => {
    const parsed = start.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request" });
      return;
    }
    try {
      res.json(await service.start(parsed.data));
    } catch (error) {
      report(error, res);
    }
  });
  router.get("/:id", async (req, res) => {
    try {
      res.json(await service.get(req.params.id));
    } catch (error) {
      report(error, res);
    }
  });
  router.patch("/:id", async (req, res) => {
    const parsed = change.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request" });
      return;
    }
    try {
      res.json(await service.change(req.params.id, parsed.data));
    } catch (error) {
      report(error, res);
    }
  });
  return router;
}
export function createSupervisionHookRouter(
  service: TaskSupervisionService,
  token?: string,
) {
  const router = Router();
  router.use((req, res, next) => {
    if (!token || req.header("x-runweave-hook-token") !== token) {
      res.status(403).json({ message: "Invalid hook identity" });
      return;
    }
    next();
  });
  router.post("/", async (req, res) => {
    const parsed = hook.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid hook" });
      return;
    }
    if (parsed.data.deadline > Date.now() + 120_000) {
      res.status(400).json({ message: "Invalid deadline" });
      return;
    }
    try {
      res.json(await service.hook(parsed.data));
    } catch (error) {
      report(error, res);
    }
  });
  router.post("/validate", async (req, res) => {
    const parsed = z
      .object({
        watchId: z.string().uuid(),
        decisionId: z.string().uuid(),
        revision: z.number().int().positive(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ valid: false });
      return;
    }
    try {
      res.json({
        valid: await service.validOffer(
          parsed.data.watchId,
          parsed.data.decisionId,
          parsed.data.revision,
        ),
      });
    } catch {
      res.json({ valid: false });
    }
  });
  return router;
}

export function registerTaskSupervisionRoutes(
  app: import("express").Express,
  service: TaskSupervisionService,
  requireAuth: import("express").RequestHandler,
  requireTunnelAuth: import("express").RequestHandler,
) {
  app.use(
    "/internal/task-supervision",
    requireTunnelAuth,
    createSupervisionHookRouter(service, process.env.RUNWEAVE_HOOK_TOKEN),
  );
  app.use(
    "/api/task-supervision",
    requireAuth,
    createTaskSupervisionRouter(service),
  );
}
