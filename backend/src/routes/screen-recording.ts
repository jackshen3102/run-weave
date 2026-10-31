import { Router, type Request } from "express";
import type { ScreenRecordingMethod } from "@runweave/shared/screen-recording";
import type { AuthService } from "../auth/service";
import { readBearerToken } from "../auth/middleware";
import type { ScreenRecordingService } from "../screen-recording/service";
import { ScreenRecordingFailure } from "../screen-recording/client";

export function createScreenRecordingRouter(service: ScreenRecordingService, auth: AuthService): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const text = (value: unknown, required = true): string | undefined => {
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || value.length === 0 || value.length > 1024 || /[\\/\0]/.test(value)) throw new ScreenRecordingFailure(400, "INVALID_ARGUMENT");
    return value;
  };
  const cursor = (req: Request, maximum: number) => {
    const result: Record<string, string | number> = {};
    if (req.query.cursor !== undefined) { if (typeof req.query.cursor !== "string" || req.query.cursor.length > 1024) throw new ScreenRecordingFailure(400, "INVALID_ARGUMENT"); result.cursor = req.query.cursor; }
    if (req.query.limit !== undefined) {
      const limit = Number(req.query.limit); if (typeof req.query.limit !== "string" || !Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new ScreenRecordingFailure(400, "INVALID_ARGUMENT"); result.limit = limit;
    }
    return result;
  };
  const register = (verb: "get" | "post" | "delete", route: string, method: ScreenRecordingMethod, params: (req: Request) => Record<string, string | number>) => {
    router[verb](route, async (req, res) => {
      const controller = new AbortController(); const abort = () => { if (!res.writableFinished) controller.abort(); }; res.on("close", abort);
      try {
        const token = readBearerToken(req); const identity = token ? auth.verifyAccessToken(token) : null;
        if (!identity) throw new ScreenRecordingFailure(401, "UNAUTHORIZED");
        const app = auth.getActiveAppSession(identity.sessionId);
        const connectionID = req.header("X-Connection-ID") ?? "";
        if (app && app.connectionId !== connectionID) throw new ScreenRecordingFailure(403, "FORBIDDEN");
        const result = await service.execute(method, params(req), { sessionID: identity.sessionId, connectionID: app?.connectionId ?? "" }, controller.signal);
        // Logout while a frame is decoding also invalidates the response.
        if (!auth.verifyAccessToken(token!)) throw new ScreenRecordingFailure(401, "UNAUTHORIZED");
        if (!controller.signal.aborted) res.type(result.header.contentType).send(result.body);
      } catch (error) {
        const safe = error instanceof ScreenRecordingFailure ? error : new ScreenRecordingFailure(503, "MEDIA_UNAVAILABLE");
        if (!controller.signal.aborted && !res.headersSent) res.status(safe.status).json({ code: safe.code, message: safe.code, retryable: safe.retryable });
      } finally { res.off("close", abort); }
    });
  };
  register("get", "/status", "status", () => ({}));
  register("get", "/days", "days", req => cursor(req, 30));
  register("get", "/ranges", "ranges", req => ({ ...cursor(req, 200), day: text(req.query.day)! }));
  register("get", "/ranges/:rangeID/thumbnail", "thumbnail", req => ({ rangeID: text(req.params.rangeID)!, catalogRevision: text(req.query.catalogRevision)! }));
  register("post", "/views", "openView", req => ({ rangeID: text(req.body?.rangeID)!, catalogRevision: text(req.body?.catalogRevision)! }));
  register("get", "/views/:viewID/availability", "availability", req => ({ viewID: text(req.params.viewID)! }));
  register("get", "/views/:viewID/frames/:captureID", "frame", req => {
    const variant = text(req.query.variant); if (!["thumb", "preview", "full"].includes(variant!)) throw new ScreenRecordingFailure(400, "INVALID_ARGUMENT");
    return { viewID: text(req.params.viewID)!, captureID: text(req.params.captureID)!, variant: variant! };
  });
  register("delete", "/views/:viewID", "closeView", req => ({ viewID: text(req.params.viewID)! }));
  return router;
}
