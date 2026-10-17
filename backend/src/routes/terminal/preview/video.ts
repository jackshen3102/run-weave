import { Router, type Router as ExpressRouter } from "express";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { AuthService } from "../../../auth/service";
import { readBearerToken } from "../../../auth/middleware";
import type { TerminalSessionManager } from "../../../terminal/manager/manager";
import {
  openPreviewVideo,
  previewVideoRange,
} from "../../../terminal/preview/video";
import { TerminalPreviewError } from "../../../terminal/preview/paths";
import type { CreateTerminalVideoPreviewTicketResponse } from "@runweave/shared/terminal/preview";

const TTL_MS = 60 * 60 * 1000;
const requestSchema = z.object({ path: z.string().min(1).max(4096) }).strict();

export function registerTerminalVideoPreviewRoutes(
  router: ExpressRouter,
  manager: TerminalSessionManager,
  auth?: AuthService,
): void {
  router.post("/project/:id/preview/video-ticket", async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid video preview path" });
      return;
    }
    const project = manager.getProject(req.params.id);
    if (!project) {
      res
        .status(manager.getProjectContext(req.params.id) ? 409 : 404)
        .json({ message: "Terminal project not found" });
      return;
    }
    if (!auth) {
      res.status(503).json({ message: "Video preview is unavailable" });
      return;
    }
    const bearer = readBearerToken(req);
    const session = bearer ? auth.verifyAccessToken(bearer) : null;
    if (!session) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    try {
      const video = await openPreviewVideo(project.path, parsed.data.path);
      try {
        const ticket = auth.issueTemporaryToken({
          sessionId: session.sessionId,
          tokenType: "video-preview",
          resource: {
            projectId: project.id,
            mediaPath: video.absolutePath,
            mediaVersion: video.version,
          },
          ttlMs: TTL_MS,
        });
        const payload: CreateTerminalVideoPreviewTicketResponse = {
          path: `/video-preview/${encodeURIComponent(ticket.token)}/${encodeURIComponent(project.id)}/${Buffer.from(video.absolutePath).toString("base64url")}/${encodeURIComponent(video.version)}`,
          expiresIn: ticket.expiresIn,
          mimeType: video.mimeType,
          sizeBytes: video.size,
        };
        res.set("Cache-Control", "no-store").json(payload);
      } finally {
        await video.handle.close();
      }
    } catch (error) {
      res
        .status(error instanceof TerminalPreviewError ? error.statusCode : 500)
        .json({
          message:
            error instanceof TerminalPreviewError
              ? error.message
              : "Video preview failed",
        });
    }
  });
}

export function createVideoPreviewRouter(
  manager: TerminalSessionManager,
  auth: AuthService,
): ExpressRouter {
  const router = Router();
  router.all("/:ticket/:projectId/:encodedPath/:version", async (req, res) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).set("Allow", "GET, HEAD").end();
      return;
    }
    const { ticket, projectId, encodedPath, version } = req.params;
    const mediaPath = Buffer.from(encodedPath, "base64url").toString("utf8");
    if (Buffer.from(mediaPath).toString("base64url") !== encodedPath) {
      res.status(400).end();
      return;
    }
    if (
      !auth.verifyTemporaryToken(ticket, {
        tokenType: "video-preview",
        resource: { projectId, mediaPath, mediaVersion: version },
      })
    ) {
      res.status(401).end();
      return;
    }
    const project = manager.getProject(projectId);
    if (!project) {
      res.status(404).end();
      return;
    }
    let video: Awaited<ReturnType<typeof openPreviewVideo>> | undefined;
    try {
      video = await openPreviewVideo(project.path, mediaPath);
      if (video.absolutePath !== mediaPath || video.version !== version) {
        res.status(409).end();
        return;
      }
      let range;
      try {
        range = previewVideoRange(req.headers.range, video.size);
      } catch {
        res.status(416).set("Content-Range", `bytes */${video.size}`).end();
        return;
      }
      res
        .status(range.partial ? 206 : 200)
        .set({
          "Content-Type": video.mimeType,
          "Accept-Ranges": "bytes",
          "Content-Length": String(range.end - range.start + 1),
          ...(range.partial
            ? {
                "Content-Range": `bytes ${range.start}-${range.end}/${video.size}`,
              }
            : {}),
        });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      await pipeline(
        video.handle.createReadStream({
          start: range.start,
          end: range.end,
          autoClose: false,
        }),
        res,
      );
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      res
        .status(error instanceof TerminalPreviewError ? error.statusCode : 500)
        .end();
    } finally {
      await video?.handle.close();
    }
  });
  return router;
}
