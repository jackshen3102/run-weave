import { Router, type Request, type Response } from "express";
import path from "node:path";
import type { AuthService } from "../../auth/service";
import type { TerminalSessionManager } from "../../terminal/manager/manager";
import { resolveHtmlPreviewEntry, resolveHtmlPreviewResource } from "../../terminal/preview/html-preview";
import { TerminalPreviewError } from "../../terminal/preview/paths";

export function createHtmlPreviewRouter(manager: TerminalSessionManager, authService: AuthService): Router {
  const router = Router();
  const handle = async (req: Request, res: Response): Promise<void> => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.status(405).set("Allow", "GET, HEAD").end(); return; }
    const { ticket, projectId, encodedPath } = req.params;
    if (typeof ticket !== "string" || typeof projectId !== "string" || typeof encodedPath !== "string") { res.status(400).end(); return; }
    const htmlPath = Buffer.from(encodedPath, "base64url").toString("utf8");
    if (Buffer.from(htmlPath, "utf8").toString("base64url") !== encodedPath) { res.status(400).end(); return; }
    const project = manager.getProject(projectId);
    if (!project) { res.status(404).end(); return; }
    if (!authService.verifyTemporaryToken(ticket, { tokenType: "html-preview", resource: { projectId, htmlPath } })) { res.status(401).end(); return; }
    try {
      const currentEntry = await resolveHtmlPreviewEntry(project.path, htmlPath);
      if (currentEntry !== htmlPath) { res.status(403).end(); return; }
      const resource = await resolveHtmlPreviewResource(htmlPath, req.params[0] ?? "");
      res.status(200).type(path.extname(resource.filePath)).set({
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Length": String(resource.size),
        "Content-Security-Policy": "sandbox allow-scripts",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      if (req.method === "HEAD") { resource.stream.destroy(); res.end(); return; }
      resource.stream.on("error", () => res.destroy());
      resource.stream.pipe(res);
    } catch (error) {
      if (error instanceof TerminalPreviewError) res.status(error.statusCode).type("text").send(error.message);
      else res.status(500).end();
    }
  };
  router.all("/:ticket/:projectId/:encodedPath", handle);
  router.all("/:ticket/:projectId/:encodedPath/*", handle);
  return router;
}
