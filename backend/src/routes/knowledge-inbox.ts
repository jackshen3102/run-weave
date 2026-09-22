import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { AuthService } from "../auth/service";
import { readBearerToken } from "../auth/middleware";
import type { KnowledgeInboxService } from "../knowledge-inbox/service";
import { InboxError } from "../knowledge-inbox/types";

const id = z.string().regex(/^[a-f0-9]{64}$/u);
const listQuery = z
  .object({
    state: z.enum(["pending", "processed"]).default("pending"),
    repositoryId: id.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();
const stateBody = z
  .object({
    state: z.enum(["pending", "processed"]),
    expectedContentVersion: id,
    expectedStateVersion: z.number().int().nonnegative(),
  })
  .strict();
export function createKnowledgeInboxRouter(
  service: KnowledgeInboxService,
  auth: AuthService,
): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  const respond =
    (operation: (req: Request, username: string) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      const token = readBearerToken(req);
      const user = token ? auth.verifyAccessToken(token) : null;
      if (!user) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }
      try {
        res.json(await operation(req, user.username));
      } catch (error) {
        const status =
          error instanceof z.ZodError
            ? 400
            : error instanceof InboxError
              ? error.status
              : 503;
        res
          .status(status)
          .json({
            message:
              error instanceof InboxError
                ? error.message
                : status === 400
                  ? "请求参数无效"
                  : "收件箱暂不可用，请重试",
          });
      }
    };
  router.get(
    "/repositories",
    respond(async (req) => {
      z.object({}).strict().parse(req.query);
      return service.listRepositories();
    }),
  );
  router.get(
    "/items",
    respond(async (req, username) =>
      service.list(username, listQuery.parse(req.query)),
    ),
  );
  router.get(
    "/items/:itemId",
    respond(async (req, username) => {
      const query = z
        .object({ contentVersion: id.optional() })
        .strict()
        .parse(req.query);
      return service.detail(
        username,
        id.parse(req.params.itemId),
        query.contentVersion,
      );
    }),
  );
  router.patch(
    "/items/:itemId/state",
    respond(async (req, username) => {
      z.object({}).strict().parse(req.query);
      return service.change(
        username,
        id.parse(req.params.itemId),
        stateBody.parse(req.body),
      );
    }),
  );
  return router;
}
