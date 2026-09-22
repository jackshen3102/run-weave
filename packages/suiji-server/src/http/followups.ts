import { Router } from "express";
import type { FollowupService } from "../followups/service";
import {
  appendFollowupSchema,
  followupListSchema,
  keySchema,
  uuid,
} from "../schema";

export function followupRouter(service: FollowupService) {
  const router = Router();
  router.get("/:id/followups", (req, res, next) => {
    void (async () =>
      res.json(
        await service.list(
          res.locals.auth.ownerId,
          uuid.parse(req.params.id),
          followupListSchema.parse(req.query),
          true,
        ),
      ))().catch(next);
  });
  router.post("/:id/followups", (req, res, next) => {
    void (async () =>
      res
        .status(201)
        .json(
          await service.append(
            {
              ownerId: res.locals.auth.ownerId,
              actor: "app",
              key: keySchema.parse(req.get("Idempotency-Key")),
              requestId: res.locals.requestId,
            },
            uuid.parse(req.params.id),
            appendFollowupSchema.parse(req.body),
          ),
        ))().catch(next);
  });
  return router;
}
