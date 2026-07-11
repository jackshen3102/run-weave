import type { Response, Router } from "express";
import type { CreateTerminalPrototypePreviewTicketResponse } from "@runweave/shared/terminal/preview";
import type { AuthService } from "../auth/service";
import { readBearerToken } from "../auth/middleware";
import type { TerminalSessionManager } from "../terminal/manager";
import {
  assertTerminalPrototypePreviewEntry,
  listTerminalPrototypeGallery,
  parseTerminalPrototypeGallerySource,
  TerminalPrototypeGalleryError,
} from "../terminal/prototype-gallery";

const PROTOTYPE_PREVIEW_TICKET_TTL_MS = 15 * 60 * 1000;

function handlePrototypeError(res: Response, error: unknown): void {
  if (error instanceof TerminalPrototypeGalleryError) {
    res.status(error.statusCode).json({ message: error.message });
    return;
  }
  res.status(500).json({ message: "Prototype gallery request failed" });
}

export function registerTerminalPrototypeGalleryRoutes(
  router: Router,
  terminalSessionManager: TerminalSessionManager,
  authService?: AuthService,
): void {
  router.get("/prototype-gallery", async (_req, res) => {
    try {
      res.json(
        await listTerminalPrototypeGallery(
          terminalSessionManager.listProjects(),
        ),
      );
    } catch (error) {
      handlePrototypeError(res, error);
    }
  });

  router.post(
    "/project/:id/prototype/:source/:slug/preview-ticket",
    async (req, res) => {
      const project = terminalSessionManager.getProject(req.params.id);
      if (!project) {
        res.status(404).json({ message: "Terminal project not found" });
        return;
      }
      if (!authService) {
        res.status(503).json({ message: "Prototype preview is unavailable" });
        return;
      }
      const accessToken = readBearerToken(req);
      const authSession = accessToken
        ? authService.verifyAccessToken(accessToken)
        : null;
      if (!authSession) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }
      const prototypeSource = parseTerminalPrototypeGallerySource(
        req.params.source,
      );
      if (!prototypeSource) {
        res.status(400).json({ message: "Invalid prototype source" });
        return;
      }
      try {
        await assertTerminalPrototypePreviewEntry({
          projectPath: project.path,
          prototypeSource,
          prototypeSlug: req.params.slug,
        });
        const ticket = authService.issueTemporaryToken({
          sessionId: authSession.sessionId,
          tokenType: "prototype-preview",
          resource: {
            projectId: project.id,
            prototypeSource,
            prototypeSlug: req.params.slug,
          },
          ttlMs: PROTOTYPE_PREVIEW_TICKET_TTL_MS,
        });
        const payload: CreateTerminalPrototypePreviewTicketResponse = {
          path: `/prototype-preview/${encodeURIComponent(ticket.token)}/${encodeURIComponent(project.id)}/${encodeURIComponent(prototypeSource)}/${encodeURIComponent(req.params.slug)}/`,
          expiresIn: ticket.expiresIn,
        };
        res.json(payload);
      } catch (error) {
        handlePrototypeError(res, error);
      }
    },
  );
}
