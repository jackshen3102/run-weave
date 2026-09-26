import { Router, type Request, type Response } from "express";
import path from "node:path";
import type { AuthService } from "../../auth/service";
import type { TerminalSessionManager } from "../../terminal/manager/manager";
import { resolveHtmlChangePreview, resolveHtmlPreviewEntry, resolveHtmlPreviewResource } from "../../terminal/preview/html-preview";
import { TerminalPreviewError } from "../../terminal/preview/paths";

export function createHtmlPreviewRouter(manager: TerminalSessionManager, authService: AuthService): Router {
  const router = Router();
  const handle = async (req: Request, res: Response, change?: { kind: "staged" | "working"; version: string }): Promise<void> => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.status(405).set("Allow", "GET, HEAD").end(); return; }
    const { ticket, projectId, encodedPath } = req.params;
    if (typeof ticket !== "string" || typeof projectId !== "string" || typeof encodedPath !== "string") { res.status(400).end(); return; }
    const htmlPath = Buffer.from(encodedPath, "base64url").toString("utf8");
    if (Buffer.from(htmlPath, "utf8").toString("base64url") !== encodedPath) { res.status(400).end(); return; }
    const project = manager.getProject(projectId);
    if (!project) { res.status(404).end(); return; }
    if (!authService.verifyTemporaryToken(ticket, { tokenType: "html-preview", resource: {
      projectId, htmlPath, ...(change ? { htmlChange: `${change.kind}:${change.version}` } : {}),
    } })) { res.status(401).end(); return; }
    try {
      if (change) {
        const snapshot = await resolveHtmlChangePreview({
          projectId, projectPath: project.path, requestedPath: htmlPath,
          changeKind: change.kind, version: change.version,
        });
        if (snapshot.htmlPath !== htmlPath) { res.status(403).end(); return; }
        if ((req.params[0] ?? "") === path.basename(htmlPath)) {
          res.status(200).type("html").set({
            "Cache-Control": "no-store",
            "Content-Security-Policy": "sandbox allow-scripts",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
          });
          if (req.method === "HEAD") { res.end(); return; }
          res.send(snapshot.content);
          return;
        }
      } else {
        const currentEntry = await resolveHtmlPreviewEntry(project.path, htmlPath);
        if (currentEntry !== htmlPath) { res.status(403).end(); return; }
      }
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
  router.all("/:ticket/:projectId/:encodedPath/change/:kind/:version/*", (req, res) => {
    const { kind, version } = req.params;
    if ((kind !== "staged" && kind !== "working") || typeof version !== "string" || !/^[a-f0-9]{64}$/.test(version)) {
      res.status(400).end(); return;
    }
    void handle(req, res, { kind, version });
  });
  router.all("/:ticket/:projectId/:encodedPath", (req, res) => { void handle(req, res); });
  router.all("/:ticket/:projectId/:encodedPath/*", (req, res) => { void handle(req, res); });
  return router;
}
