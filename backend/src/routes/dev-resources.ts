import { Router } from "express";
import { z } from "zod";
import type { DevResourcesService } from "../dev-resources/service";
import { DevResourceError } from "../dev-resources/control";

const releaseSchema = z
  .object({
    action: z.enum(["stop-and-release", "release-occupancy"]),
    expectedOwnershipVersion: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export function createDevResourcesRouter(service: DevResourcesService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/", async (_req, res, next) => {
    try {
      res.json(await service.getSnapshot());
    } catch (error) {
      if (error instanceof DevResourceError)
        res.status(error.status).json({ message: error.message });
      else next(error);
    }
  });
  router.post("/:resourceId/release", async (req, res, next) => {
    const parsed = releaseSchema.safeParse(req.body);
    if (
      !parsed.success ||
      !/^(?:slot:pool-0[1-5]|session:[a-z0-9-]{1,48}|simulator:[A-F0-9-]{36})$/.test(
        req.params.resourceId,
      )
    ) {
      res.status(400).json({ message: "无效的资源释放请求" });
      return;
    }
    try {
      const result = await service.release(req.params.resourceId, parsed.data);
      res.status(result.state === "running" ? 202 : 200).json(result);
    } catch (error) {
      if (error instanceof DevResourceError)
        res
          .status(error.status === 200 ? 503 : error.status)
          .json({ message: error.message });
      else next(error);
    }
  });
  return router;
}
