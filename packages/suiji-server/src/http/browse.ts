import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { BrowseService } from "../browse/service";
import type { AttachmentService } from "../storage/attachments";
import * as schema from "../browse/schema";
import { keySchema, uuid } from "../schema";
import type { Mutation } from "../records/mutations";
const route =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res).catch(next);
  };
export function browseRouter(
  service: BrowseService,
  attachments: AttachmentService,
) {
  const router = Router();
  const owner = (res: Response): string => res.locals.auth.ownerId;
  const ctx = (req: Request, res: Response): Mutation => ({
    ownerId: owner(res),
    actor: "app",
    key: keySchema.parse(req.get("Idempotency-Key")),
    requestId: res.locals.requestId,
  });
  router.get(
    "/entries",
    route(async (req, res) =>
      res.json(
        await service.list(owner(res), schema.browseList.parse(req.query)),
      ),
    ),
  );
  router.post(
    "/entries",
    route(async (req, res) =>
      res
        .status(201)
        .json(
          await service.create(
            ctx(req, res),
            schema.browseCreate.parse(req.body),
          ),
        ),
    ),
  );
  router.get(
    "/entries/:id",
    route(async (req, res) =>
      res.json({
        entry: await service.get(owner(res), uuid.parse(req.params.id)),
      }),
    ),
  );
  router.get(
    "/entries/:id/content",
    route(async (req, res) =>
      res.json(
        await service.content(
          owner(res),
          uuid.parse(req.params.id),
          schema.contentInput.parse(req.query),
        ),
      ),
    ),
  );
  router.get(
    "/entries/:id/history",
    route(async (req, res) =>
      res.json(await service.history(owner(res), uuid.parse(req.params.id))),
    ),
  );
  router.patch(
    "/entries/:id",
    route(async (req, res) =>
      res.json(
        await service.edit(
          ctx(req, res),
          uuid.parse(req.params.id),
          schema.browseEdit.parse(req.body),
        ),
      ),
    ),
  );
  router.post(
    "/entries/:id/trash",
    route(async (req, res) =>
      res.json(
        await service.trash(
          ctx(req, res),
          uuid.parse(req.params.id),
          schema.browseTrash.parse(req.body),
        ),
      ),
    ),
  );
  router.get(
    "/changes",
    route(async (req, res) =>
      res.json(
        await service.changes(owner(res), schema.changesInput.parse(req.query)),
      ),
    ),
  );
  router.get(
    "/connections",
    route(async (_req, res) => res.json(await service.connections(owner(res)))),
  );
  router.post(
    "/connections",
    route(async (req, res) =>
      res
        .status(201)
        .json(
          await service.createConnection(
            ctx(req, res),
            schema.connectionCreate.parse(req.body),
          ),
        ),
    ),
  );
  router.patch(
    "/connections/:id",
    route(async (req, res) =>
      res.json(
        await service.updateConnection(
          ctx(req, res),
          uuid.parse(req.params.id),
          schema.connectionEdit.parse(req.body),
        ),
      ),
    ),
  );
  router.post("/failures", route(async (req,res) => res.json(await service.failure(ctx(req,res),schema.failureInput.parse(req.body)))));
  router.post(
    "/imports",
    route(async (req, res) =>
      res.json(
        await service.import(
          ctx(req, res),
          schema.browseImport.parse(req.body),
        ),
      ),
    ),
  );
  router.get(
    "/runs/:id",
    route(async (req, res) =>
      res.json(await service.run(owner(res), uuid.parse(req.params.id))),
    ),
  );
  router.get(
    "/digests",
    route(async (req, res) =>
      res.json(
        await service.digests(owner(res), schema.digestList.parse(req.query)),
      ),
    ),
  );
  router.post(
    "/digests",
    route(async (req, res) =>
      res.json(
        await service.publishDigest(
          ctx(req, res),
          schema.digestInput.parse(req.body),
        ),
      ),
    ),
  );
  router.get(
    "/attachments/:id/content",
    route(async (req, res) => {
      const content = await attachments.content(
        owner(res),
        uuid.parse(req.params.id),
        false,
        "browse",
      );
      res.set({
        "Content-Type": content.mimeType,
        "Content-Length": String(content.byteSize),
        "Content-Security-Policy": "default-src 'none'; sandbox",
      });
      content.stream.on("error", () => res.destroy());
      content.stream.pipe(res);
    }),
  );
  return router;
}
