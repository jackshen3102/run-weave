import { json, Router, type Express, type RequestHandler } from "express";
import type { QualityService } from "../../quality-workflow/service";
import { QualityStoreError } from "../../quality-workflow/store";
export function installQualityWorkflowBodyParsers(app: Express, ...authorize: RequestHandler[]) {
  app.post("/api/quality-workflow/batches", ...authorize, json({ limit: "256kb" }));
  app.post("/api/quality-workflow/events/context", ...authorize, json({ limit: "1mb" }));
  app.post("/api/quality-workflow/issues/:issueId/handoff", ...authorize, json({ limit: "64kb" }));
}
export function createQualityWorkflowRouter(service: QualityService): Router {
  const router = Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/capabilities", (_req, res) => res.json(service.capabilities()));
  const handle = (work: (req: import("express").Request) => unknown) => async (req: import("express").Request, res: import("express").Response) => {
    try { res.json(await work(req)); } catch (error) {
      const failure = error instanceof QualityStoreError ? error : new QualityStoreError(503, "quality_store_unavailable");
      res.status(failure.status).json({ message: failure.code, code: failure.code, details: failure.details });
    }
  };
  // One bounded batch per second per authenticated installation stream; no raw payload logging.
  const arrivals = new Map<string, number>();
  router.post("/batches", handle(req => {
    const key = typeof req.body?.sourceId === "string" ? req.body.sourceId.slice(0, 128) : "invalid";
    const now = Date.now();
    for (const [id, at] of arrivals) if (now - at > 1000) arrivals.delete(id);
    if (arrivals.has(key) || arrivals.size >= 1024) throw new QualityStoreError(429, "upload_rate_limited");
    arrivals.set(key, now); return service.ingest(req.body);
  }));
  router.get("/events", handle(req => {
    const cursor = req.query.cursor; const raw = req.query.limit ?? "200";
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 512) || typeof raw !== "string" || !/^[1-9]\d{0,3}$/.test(raw) || Number(raw) > 1000) throw new QualityStoreError(400, "invalid_pagination");
    return service.events(cursor as string | undefined, Number(raw));
  }));
  router.post("/events/context", handle(req => service.context(req.body)));
  router.get("/coverage", handle(() => service.coverage()));
  router.get("/latency-baselines", handle(() => service.latencyBaselines()));
  router.get("/ledger", handle(req => {
    if (req.query.issueId !== undefined && typeof req.query.issueId !== "string") throw new QualityStoreError(400, "invalid_issue_id");
    return service.ledger(req.query.issueId as string | undefined);
  }));
  router.post("/ledger/commit", handle(req => service.commit(req.body)));
  router.post("/issues/:issueId/handoff", handle(req => service.handoff(String(req.params.issueId ?? ""), req.body)));
  return router;
}
