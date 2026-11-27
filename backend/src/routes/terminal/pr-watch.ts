import type { Router, Request, Response } from "express";
import { z } from "zod";
import type { PrWatchService } from "../../pr-watch/service";
import { SupervisionError } from "../../task-supervision/errors";

const start = z
  .object({
    operationId: z.string().trim().min(1).max(128),
    prNumber: z.number().int().positive().safe().optional(),
    prUrl: z.string().max(512).optional(),
  })
  .strict()
  .refine((r) => !(r.prNumber && r.prUrl));
const change = z
  .object({
    action: z.enum(["pause", "resume", "confirm_empty_draft_and_deliver"]),
    expectedRevision: z.number().int().positive(),
    expectedInputVersion: z.string().max(128).optional(),
  })
  .strict();
export function registerPrWatch(router: Router, service: PrWatchService) {
  const path = "/session/:id/pr-watch";
  const handle =
    (fn: (req: Request, res: Response, id: string) => Promise<void>) =>
    async (req: Request, res: Response) => {
      try {
        await service.track(fn(req, res, String(req.params.id)));
      } catch (error) {
        res
          .status(error instanceof SupervisionError ? error.status : 500)
          .json({
            message:
              error instanceof SupervisionError
                ? error.message
                : "无法完成 PR 值守操作。",
          });
      }
    };
  router.get(
    path,
    handle(async (req, res, id) => {
      res.json(await service.inspect(id, req.query.detect === "true"));
    }),
  );
  router.post(
    path,
    handle(async (req, res, id) => {
      const body = start.safeParse(req.body);
      if (!body.success)
        throw new SupervisionError("请指定同仓库的 PR 编号或 URL。", 400);
      res.status(201).json({ watch: await service.bind(id, body.data) });
    }),
  );
  router.patch(
    path,
    handle(async (req, res, id) => {
      const body = change.safeParse(req.body);
      if (!body.success) throw new SupervisionError("无效的值守操作。", 400);
      res.json({ watch: await service.change(id, body.data) });
    }),
  );
  router.delete(
    path,
    handle(async (_req, res, id) => {
      service.remove(id);
      res.sendStatus(204);
    }),
  );
}
