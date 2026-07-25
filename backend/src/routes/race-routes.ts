import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import type { CreateRaceRequest } from "@runweave/shared/race";
import type { RaceService } from "../race/race-service";
import { toRaceError } from "../race/race-service";

const workerSchema = z
  .object({
    agent: z.enum(["codex", "traex"]),
    model: z.string().trim().max(200),
  })
  .strict();

const createRaceSchema = z
  .object({
    parentProjectId: z.string().trim().min(1),
    goal: z.string().trim().min(1).max(8_000),
    plan: z.string().trim().min(1).max(32_000),
    baseRef: z.string().trim().min(1).max(500),
    workers: z.array(workerSchema).min(1).max(32),
  })
  .strict();

export function createRaceRouter(service: RaceService): Router {
  const router = Router();

  router.get("/agents", async (_req, res) => {
    res.json(await service.getAgentCatalog());
  });

  router.get("/", async (_req, res, next) => {
    try {
      res.json(await service.getCurrent());
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    const parsed = createRaceSchema.safeParse(
      req.body as CreateRaceRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }
    try {
      res.status(201).json(await service.create(parsed.data));
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:raceId", async (req, res, next) => {
    try {
      await service.end(req.params.raceId);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.delete(
    "/:raceId/worktree/:workerId",
    async (req, res, next) => {
      try {
        await service.removeWorktree(
          req.params.raceId,
          req.params.workerId,
        );
        res.json({ ok: true });
      } catch (error) {
        next(error);
      }
    },
  );

  router.use(
    (
      error: unknown,
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      void _next;
      const raceError = toRaceError(error);
      res.status(raceError.statusCode).json({
        message: raceError.message,
        ...(raceError.code ? { code: raceError.code } : {}),
      });
    },
  );

  return router;
}
