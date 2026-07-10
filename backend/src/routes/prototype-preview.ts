import type { Request, Response } from "express";
import { Router } from "express";
import path from "node:path";
import type { AuthService } from "../auth/service";
import type { TerminalSessionManager } from "../terminal/manager";
import {
  resolveTerminalPrototypePreviewFile,
  TerminalPrototypeGalleryError,
} from "../terminal/prototype-gallery";

function sendPreviewError(res: Response, error: unknown): void {
  if (error instanceof TerminalPrototypeGalleryError) {
    res.status(error.statusCode).type("text").send(error.message);
    return;
  }
  res.status(500).type("text").send("Prototype preview failed");
}

export function createPrototypePreviewRouter(
  terminalSessionManager: TerminalSessionManager,
  authService: AuthService,
): Router {
  const router = Router();
  const handlePreview = async (req: Request, res: Response): Promise<void> => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).set("Allow", "GET, HEAD").end();
      return;
    }
    const ticket =
      typeof req.params.ticket === "string" ? req.params.ticket : null;
    const projectId =
      typeof req.params.projectId === "string" ? req.params.projectId : null;
    const prototypeSlug =
      typeof req.params.prototypeSlug === "string"
        ? req.params.prototypeSlug
        : null;
    if (!ticket || !projectId || !prototypeSlug) {
      res.status(400).type("text").send("Invalid prototype preview path");
      return;
    }
    const project = terminalSessionManager.getProject(projectId);
    if (!project) {
      res.status(404).type("text").send("Terminal project not found");
      return;
    }
    const verified = authService.verifyTemporaryToken(ticket, {
      tokenType: "prototype-preview",
      resource: {
        projectId: project.id,
        prototypeSlug,
      },
    });
    if (!verified) {
      res.status(401).type("text").send("Prototype preview ticket is invalid");
      return;
    }
    try {
      const preview = await resolveTerminalPrototypePreviewFile({
        projectPath: project.path,
        prototypeSlug,
        requestedPath: typeof req.params[0] === "string" ? req.params[0] : "",
      });
      res
        .status(200)
        .type(path.extname(preview.filePath))
        .set({
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
          "Content-Length": String(preview.size),
          "Cross-Origin-Resource-Policy": "cross-origin",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        });
      if (req.method === "HEAD") {
        preview.stream.destroy();
        res.end();
        return;
      }
      preview.stream.on("error", () => {
        if (!res.headersSent) {
          res.status(500).end();
        } else {
          res.destroy();
        }
      });
      preview.stream.pipe(res);
    } catch (error) {
      sendPreviewError(res, error);
    }
  };

  router.all("/:ticket/:projectId/:prototypeSlug", handlePreview);
  router.all("/:ticket/:projectId/:prototypeSlug/*", handlePreview);
  return router;
}
