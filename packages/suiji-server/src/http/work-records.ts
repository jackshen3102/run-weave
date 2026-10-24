import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { WorkRecordService } from "../work-records/service";
import { keySchema, uuid } from "../schema";
import * as schema from "../work-records/schema";

export function workRecordRouter(service: WorkRecordService) {
  const router = Router();
  const route =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => {
      void fn(req, res).catch(next);
    };
  const context = (req: Request, res: Response) => ({
    ownerId: res.locals.auth.ownerId as string,
    actor: "app" as const,
    key: keySchema.parse(req.get("Idempotency-Key")),
    requestId: res.locals.requestId as string,
  });
  router.get(
    "/",
    route(async (req, res) =>
      res.json(
        await service.list(
          res.locals.auth.ownerId,
          schema.workList.parse(req.query),
        ),
      ),
    ),
  );
  router.post(
    "/",
    route(async (req, res) =>
      res
        .status(201)
        .json(
          await service.create(
            context(req, res),
            schema.workCreate.parse(req.body),
          ),
        ),
    ),
  );
  router.post(
    "/reclassify",
    route(async (req, res) =>
      res.json(
        await service.reclassify(
          context(req, res),
          schema.reclassify.parse(req.body),
        ),
      ),
    ),
  );
  router.post(
    "/reclassify/undo",
    route(async (req, res) =>
      res.json(
        await service.restoreProjects(
          context(req, res),
          schema.restoreProjects.parse(req.body),
        ),
      ),
    ),
  );
  router.get(
    "/:id",
    route(async (req, res) =>
      res.json({
        fact: await service.get(
          res.locals.auth.ownerId,
          uuid.parse(req.params.id),
        ),
      }),
    ),
  );
  router.patch(
    "/:id",
    route(async (req, res) =>
      res.json(
        await service.edit(
          context(req, res),
          uuid.parse(req.params.id),
          schema.workEdit.parse(req.body),
        ),
      ),
    ),
  );
  return router;
}
