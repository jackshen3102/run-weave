import type { Router } from "express";
import { z } from "zod";
import type { AuthService } from "../../../auth/service";
import { readBearerToken } from "../../../auth/middleware";
import type { TerminalSessionManager } from "../../../terminal/manager/manager";
import { resolveHtmlChangePreview, resolveHtmlPreviewEntry } from "../../../terminal/preview/html-preview";
import { TerminalPreviewError } from "../../../terminal/preview/paths";
import type { CreateTerminalHtmlPreviewTicketResponse } from "@runweave/shared/terminal/preview";

const TTL_MS = 15 * 60 * 1000;
const requestSchema = z.object({
  path: z.string().min(1).max(4096),
  changeKind: z.enum(["staged", "working"]).optional(),
  version: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).refine((value) => Boolean(value.changeKind) === Boolean(value.version));

export function registerTerminalHtmlPreviewRoutes(router: Router, manager: TerminalSessionManager, authService?: AuthService): void {
  router.post("/project/:id/preview/html-ticket", async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ message: "Invalid HTML preview path" }); return; }
    const project = manager.getProject(req.params.id);
    if (!project) { res.status(manager.getProjectContext(req.params.id) ? 409 : 404).json({ message: "Terminal project not found" }); return; }
    if (!authService) { res.status(503).json({ message: "HTML preview is unavailable" }); return; }
    const bearer = readBearerToken(req);
    const session = bearer ? authService.verifyAccessToken(bearer) : null;
    if (!session) { res.status(401).json({ message: "Unauthorized" }); return; }
    try {
      const change = parsed.data.changeKind && parsed.data.version
        ? { kind: parsed.data.changeKind, version: parsed.data.version } : null;
      const htmlPath = change
        ? (await resolveHtmlChangePreview({
          projectId: project.id, projectPath: project.path, requestedPath: parsed.data.path,
          changeKind: change.kind, version: change.version,
        })).htmlPath
        : await resolveHtmlPreviewEntry(project.path, parsed.data.path);
      const ticket = authService.issueTemporaryToken({
        sessionId: session.sessionId,
        tokenType: "html-preview",
        resource: { projectId: project.id, htmlPath,
          ...(change ? { htmlChange: `${change.kind}:${change.version}` } : {}) },
        ttlMs: TTL_MS,
      });
      const encodedPath = Buffer.from(htmlPath, "utf8").toString("base64url");
      const payload: CreateTerminalHtmlPreviewTicketResponse = {
        path: `/html-preview/${encodeURIComponent(ticket.token)}/${encodeURIComponent(project.id)}/${encodedPath}/${change ? `change/${change.kind}/${change.version}/` : ""}${encodeURIComponent(htmlPath.split("/").at(-1)!)}`,
        expiresIn: ticket.expiresIn,
      };
      res.json(payload);
    } catch (error) {
      if (error instanceof TerminalPreviewError) res.status(error.statusCode).json({ message: error.message });
      else res.status(500).json({ message: "HTML preview failed" });
    }
  });
}
