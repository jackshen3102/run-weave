import { Router } from "express";
import type { WorkReportService } from "../work-reports/service";
import { keySchema, uuid } from "../schema";
import * as schema from "../work-reports/schema";

export function workReportRouter(service: WorkReportService) {
  const router = Router();
  router.get("/:id", (req,res,next) => {
    void service.get(res.locals.auth.ownerId, uuid.parse(req.params.id)).then(report => res.json({ report }), next);
  });
  router.patch("/:id", (req,res,next) => {
    try {
      const ctx = { ownerId: res.locals.auth.ownerId as string, actor: "app" as const, key: keySchema.parse(req.get("Idempotency-Key")), requestId: res.locals.requestId as string };
      void service.edit(ctx, uuid.parse(req.params.id), schema.edit.parse(req.body)).then(value => res.json(value), next);
    } catch (e) { next(e); }
  });
  return router;
}
