import type { Router, Response } from "express";
import { z } from "zod";
import { CodeReviewError } from "../../terminal/code-review/store";
import type { CodeReviewService } from "../../terminal/code-review/service";
const createSchema = z.object({ requestId: z.string().min(1).max(100), panelId: z.string().min(1).nullable().optional(),
  expectedTarget: z.object({ projectId: z.string().min(1), threadId: z.string().min(1).nullable(), provider: z.string().min(1).nullable() }).strict().optional(),
}).strict();
export function registerTerminalCodeReviewRoutes(router: Router, service?: CodeReviewService) {
  const error = (res: Response, caught: unknown) => {
    if (caught instanceof CodeReviewError) res.status(caught.status).json({ code: caught.code, message: caught.message });
    else res.status(503).json({ code: "review_unavailable", message: "代码 Review 暂不可用" });
  };
  const ready = () => { if (!service) throw new CodeReviewError(501, "unsupported", "此电脑尚不支持代码 Review"); return service; };
  router.post("/session/:id/code-reviews", async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ code: "invalid_request", message: "Review 请求无效" }); return; }
    try { res.status(202).json(await ready().create(req.params.id, parsed.data)); } catch (caught) { error(res, caught); }
  });
  router.get("/session/:id/code-reviews", (req, res) => {
    try {
      const before = z.string().uuid().optional().parse(req.query.before);
      res.json(ready().list(req.params.id, before));
    } catch (caught) { error(res, caught); }
  });
  router.get("/code-reviews/:reviewId", async (req, res) => {
    try { res.json(await ready().detail(req.params.reviewId)); } catch (caught) { error(res, caught); }
  });
  router.get("/code-reviews/:reviewId/artifacts/:artifactId", async (req, res) => {
    try {
      const artifact = await ready().artifact(req.params.reviewId, req.params.artifactId);
      res.set("Cache-Control", "no-store").set("X-Content-Type-Options", "nosniff").type(artifact.mimeType).send(artifact.bytes);
    } catch (caught) { error(res, caught); }
  });
}
