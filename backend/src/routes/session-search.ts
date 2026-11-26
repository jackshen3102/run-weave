import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { SessionSearchError, type SessionSearchService } from "../session-search/service";

const flag = z.enum(["true", "false"]).transform(value => value === "true").optional();
const search = z.object({
  query: z.string().trim().min(1).max(500), projectId: z.string().min(1).max(200).optional(),
  cwd: z.string().min(1).max(4096).optional(), allProjects: flag,
  provider: z.enum(["codex", "pi", "claude", "agy"]).optional(), level: z.enum(["chat", "work", "full"]).optional(),
  noUpdate: flag, includeOtherOrigins: flag, from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(), cursor: z.string().max(2000).optional(),
}).strict().refine(value => value.allProjects ? !value.cwd && !value.projectId : Boolean(value.cwd) !== Boolean(value.projectId), "Specify one project or explicitly allProjects");

export function createSessionSearchRouter(service: SessionSearchService): Router {
  const router = Router();
  const handle = (action: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    void action(req, res).catch((error: unknown) => {
      const invalid = error instanceof z.ZodError;
      res.status(invalid ? 400 : error instanceof SessionSearchError ? error.status : 503).json({
        message: invalid ? "请求参数无效" : error instanceof SessionSearchError ? error.code : "历史搜索暂不可用",
        code: invalid ? "session_search_invalid_request" : error instanceof SessionSearchError ? error.code : "session_search_unavailable",
      });
    });
  };
  router.get("/status", handle(async (_req, res) => res.json(await service.status())));
  router.post("/refresh", handle(async (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    res.json(await service.refresh());
  }));
  router.get("/search", handle(async (req, res) => res.json(await service.search(search.parse(req.query)))));
  router.get("/records/:id", handle(async (req, res) => {
    const id = z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.id);
    const query = z.object({ noUpdate: flag }).strict().parse(req.query);
    res.json(await service.context(id, query.noUpdate));
  }));
  return router;
}
