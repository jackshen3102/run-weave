import { randomUUID } from "node:crypto";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { ZodError } from "zod";
import type pg from "pg";
import { SUIJI_LIMITS, SUIJI_PROTOCOL_VERSION } from "@runweave/shared/suiji";
import type { Config } from "../config";
import { AuthService, type AuthContext } from "../auth/service";
import { RecordService } from "../records/service";
import type { Mutation } from "../records/mutations";
import { AttachmentService } from "../storage/attachments";
import { LocalFileStore } from "../storage/local-files";
import { ServiceError, unauthenticated } from "../errors";
import {
  createSchema,
  editSchema,
  statusSchema,
  listSchema,
  loginSchema,
  refreshSchema,
  uuid,
  keySchema,
} from "../schema";
import { receiveUpload } from "./upload";
import { createMcpRouter } from "../mcp/router";
import { webCors } from "./cors";
import { ReviewService } from "../reviews/service";
import { reviewInput } from "../reviews/schema";
const route =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res).catch(next);
  };
export function createApp(
  pool: pg.Pool,
  store: LocalFileStore,
  config: Config,
) {
  const app = express(),
    auth = new AuthService(pool, config),
    records = new RecordService(pool),
    attachments = new AttachmentService(pool, store);
  const reviews = new ReviewService(config, records, attachments);
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((_req, res, next) => {
    res.locals.requestId = randomUUID();
    res.set({
      "X-Request-Id": res.locals.requestId,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    next();
  });
  app.get(
    "/health",
    route(async (_req, res) => {
      await pool.query("SELECT 1");
      res.json({ ok: true });
    }),
  );
  app.use(express.json({ limit: "256kb" }));
  app.use("/mcp", createMcpRouter(pool, records, attachments, config));
  app.use("/api", webCors(config.SUIJI_WEB_ORIGINS));
  app.post(
    "/api/auth/login",
    route(async (req, res) => {
      const v = loginSchema.parse(req.body);
      res.json(
        await auth.login(
          v.username,
          v.password,
          req.socket.remoteAddress ?? "unknown",
        ),
      );
    }),
  );
  app.post(
    "/api/auth/refresh",
    route(async (req, res) => {
      res.json(await auth.refresh(refreshSchema.parse(req.body).refreshToken));
    }),
  );
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9_-]{20,256})$/,
    )?.[1];
    if (!token) {
      next(unauthenticated());
      return;
    }
    void auth.authenticate(token).then((value) => {
      res.locals.auth = value;
      next();
    }, next);
  });
  app.post(
    "/api/auth/logout",
    route(async (_req, res) => {
      await auth.logout(res.locals.auth);
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/auth/verify",
    route(async (_req, res) => {
      const a = res.locals.auth as AuthContext;
      res.json({ valid: true, ownerId: a.ownerId, serverId: a.serverId });
    }),
  );
  app.get(
    "/api/suiji/v1/info",
    route(async (_req, res) => {
      const a = res.locals.auth as AuthContext;
      const schema = await pool.query(
        "SELECT count(*)::int AS version FROM suiji_migrations",
      );
      res.json({
        protocolVersion: SUIJI_PROTOCOL_VERSION,
        ownerId: a.ownerId,
        serverId: a.serverId,
        appVersion: config.SUIJI_APP_VERSION,
        schemaVersion: schema.rows[0].version,
        limits: SUIJI_LIMITS,
        ai: reviews.info(),
      });
    }),
  );
  const context = (req: Request, res: Response): Mutation => ({
    ownerId: res.locals.auth.ownerId,
    actor: "app",
    key: keySchema.parse(req.get("Idempotency-Key")),
    requestId: res.locals.requestId,
  });
  const root = "/api/suiji/v1";
  app.post(`${root}/reviews`, route(async (req, res) => {
    res.status(202).json(reviews.start(res.locals.auth.ownerId,
      keySchema.parse(req.get("Idempotency-Key")), reviewInput.parse(req.body), res.locals.requestId));
  }));
  app.get(`${root}/reviews/:id`, route(async (req, res) => {
    res.json(reviews.get(res.locals.auth.ownerId, uuid.parse(req.params.id)));
  }));
  app.delete(`${root}/reviews/:id`, route(async (req, res) => {
    res.json(reviews.cancel(res.locals.auth.ownerId, uuid.parse(req.params.id)));
  }));
  app.get(
    `${root}/records`,
    route(async (req, res) =>
      res.json(
        await records.list(
          res.locals.auth.ownerId,
          listSchema.parse(req.query),
        ),
      ),
    ),
  );
  app.get(
    `${root}/records/:id`,
    route(async (req, res) =>
      res.json({
        record: await records.get(
          res.locals.auth.ownerId,
          uuid.parse(req.params.id),
        ),
      }),
    ),
  );
  app.post(
    `${root}/records`,
    route(async (req, res) =>
      res
        .status(201)
        .json(
          await records.create(context(req, res), createSchema.parse(req.body)),
        ),
    ),
  );
  app.patch(
    `${root}/records/:id`,
    route(async (req, res) =>
      res.json(
        await records.edit(
          context(req, res),
          uuid.parse(req.params.id),
          editSchema.parse(req.body),
        ),
      ),
    ),
  );
  app.post(
    `${root}/records/:id/task-status`,
    route(async (req, res) =>
      res.json(
        await records.status(
          context(req, res),
          uuid.parse(req.params.id),
          statusSchema.parse(req.body),
        ),
      ),
    ),
  );
  app.post(
    `${root}/uploads`,
    route(async (req, res) => {
      const mutation = context(req, res),
        upload = await receiveUpload(req, store);
      try {
        res
          .status(201)
          .json(
            await attachments.upload(
              mutation,
              upload.staged,
              upload.name,
              upload.mime,
            ),
          );
      } finally {
        await store.discard(upload.staged.key);
      }
    }),
  );
  app.get(
    `${root}/attachments/:id/content`,
    route(async (req, res) => {
      const content = await attachments.content(
        res.locals.auth.ownerId,
        uuid.parse(req.params.id),
      );
      res.set({
        "Content-Type":
          content.mimeType === "text/markdown"
            ? "text/markdown; charset=utf-8"
            : content.mimeType,
        "Content-Length": String(content.byteSize),
        "Content-Security-Policy": "default-src 'none'; sandbox",
      });
      content.stream.on("error", () => res.destroy());
      content.stream.pipe(res);
    }),
  );
  app.use((_req, res) =>
    res
      .status(404)
      .json({
        ok: false,
        error: { code: "NOT_FOUND", message: "接口不存在", retryable: false },
        requestId: res.locals.requestId,
      }),
  );
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      void _next;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const e =
        error instanceof ServiceError
          ? error
          : error instanceof ZodError || error instanceof SyntaxError
            ? new ServiceError(
                400,
                "INVALID_ARGUMENT",
                "输入不合法",
                error instanceof ZodError
                  ? {
                      fields: error.issues.map((i) => ({
                        path: i.path,
                        message: i.message,
                      })),
                    }
                  : undefined,
              )
            : (error as { type?: string })?.type === "entity.too.large"
              ? new ServiceError(413, "PAYLOAD_TOO_LARGE", "请求超过限额")
              : new ServiceError(
                  503,
                  "DEPENDENCY_UNAVAILABLE",
                  "服务暂时不可用，请手动重试",
                );
      if (e.status === 429)
        res.set("Retry-After", String(e.details?.retryAfter ?? 60));
      console.error(
        JSON.stringify({
          requestId: res.locals.requestId,
          status: e.status,
          code: e.code,
        }),
      );
      res
        .status(e.status)
        .json({
          ok: false,
          error: {
            code: e.code,
            message: e.message,
            retryable: e.status === 503 || e.status === 429,
            details: e.details,
          },
          requestId: res.locals.requestId,
        });
    },
  );
  return Object.assign(app, { closeReviews: () => reviews.close() });
}
