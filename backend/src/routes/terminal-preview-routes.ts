import type { Response, Router } from "express";
import { z } from "zod";
import type { TerminalSessionManager } from "../terminal/manager";
import {
  getPreviewFileDiff,
  getPreviewGitChanges,
  readPreviewAsset,
  readPreviewFile,
  searchPreviewFiles,
  TerminalPreviewError,
} from "../terminal/preview";

const previewFileSearchSchema = z.object({
  q: z.string().optional().default(""),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const previewFileSchema = z.object({
  path: z.string().min(1),
});

const previewFileDiffSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["staged", "working"]),
});

function resolveProjectPreviewContext(
  terminalSessionManager: TerminalSessionManager,
  projectId: string,
) {
  const project = terminalSessionManager.getProject(projectId);
  if (!project) {
    throw new TerminalPreviewError("Terminal project not found", 404);
  }
  return { project };
}

function handlePreviewError(res: Response, error: unknown) {
  if (error instanceof TerminalPreviewError) {
    res.status(error.statusCode).json({ message: error.message });
    return;
  }
  console.error("[viewer-be] terminal preview request failed", {
    error: String(error),
  });
  res.status(500).json({
    message: "Terminal preview request failed",
    error: String(error),
  });
}

export function registerTerminalPreviewRoutes(
  router: Router,
  terminalSessionManager: TerminalSessionManager,
): void {
  router.get("/project/:id/preview/files/search", async (req, res) => {
    const parsed = previewFileSearchSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request query",
        errors: parsed.error.flatten(),
      });
      return;
    }

    try {
      const { project } = resolveProjectPreviewContext(
        terminalSessionManager,
        req.params.id,
      );
      res.json(
        await searchPreviewFiles({
          projectId: project.id,
          projectPath: project.path,
          query: parsed.data.q,
          limit: parsed.data.limit,
        }),
      );
    } catch (error) {
      handlePreviewError(res, error);
    }
  });

  router.get("/project/:id/preview/file", async (req, res) => {
    const parsed = previewFileSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request query",
        errors: parsed.error.flatten(),
      });
      return;
    }

    try {
      const { project } = resolveProjectPreviewContext(
        terminalSessionManager,
        req.params.id,
      );
      res.json(
        await readPreviewFile({
          projectId: project.id,
          projectPath: project.path,
          requestedPath: parsed.data.path,
        }),
      );
    } catch (error) {
      handlePreviewError(res, error);
    }
  });

  router.get("/project/:id/preview/asset", async (req, res) => {
    const parsed = previewFileSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request query",
        errors: parsed.error.flatten(),
      });
      return;
    }

    try {
      const { project } = resolveProjectPreviewContext(
        terminalSessionManager,
        req.params.id,
      );
      const payload = await readPreviewAsset({
        projectId: project.id,
        projectPath: project.path,
        requestedPath: parsed.data.path,
      });
      res
        .status(200)
        .type(payload.mimeType)
        .set("Cache-Control", payload.cacheControl)
        .send(payload.content);
    } catch (error) {
      handlePreviewError(res, error);
    }
  });

  router.get("/project/:id/preview/git-changes", async (req, res) => {
    try {
      const { project } = resolveProjectPreviewContext(
        terminalSessionManager,
        req.params.id,
      );
      res.json(
        await getPreviewGitChanges({
          projectId: project.id,
          projectPath: project.path,
        }),
      );
    } catch (error) {
      handlePreviewError(res, error);
    }
  });

  router.get("/project/:id/preview/file-diff", async (req, res) => {
    const parsed = previewFileDiffSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request query",
        errors: parsed.error.flatten(),
      });
      return;
    }

    try {
      const { project } = resolveProjectPreviewContext(
        terminalSessionManager,
        req.params.id,
      );
      res.json(
        await getPreviewFileDiff({
          projectId: project.id,
          projectPath: project.path,
          requestedPath: parsed.data.path,
          changeKind: parsed.data.kind,
        }),
      );
    } catch (error) {
      handlePreviewError(res, error);
    }
  });
}
