import type { Response, Router } from "express";
import { z } from "zod";
import { logger } from "../logging";
import type { TerminalSessionManager } from "../terminal/manager";
import { listPreviewDirectory } from "../terminal/preview-directory";
import {
  deletePreviewFile,
  getPreviewFileDiff,
  getPreviewGitChanges,
  readPreviewAsset,
  readPreviewFile,
  renamePreviewFile,
  resetPreviewGitChange,
  savePreviewFile,
  searchPreviewFiles,
  TerminalPreviewError,
} from "../terminal/preview";

const terminalPreviewLogger = logger.child({ component: "terminal-preview" });

const previewFileSearchSchema = z.object({
  q: z.string().optional().default(""),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const previewDirectorySchema = z.object({
  path: z.string().optional().default(""),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const previewFileSchema = z.object({
  path: z.string().min(1),
});

const previewSaveFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  expectedMtimeMs: z.number().finite(),
  overwrite: z.boolean().optional(),
});

const previewDeleteFileSchema = z.object({
  path: z.string().min(1),
  expectedMtimeMs: z.number().finite().optional(),
});

const previewRenameFileSchema = z.object({
  path: z.string().min(1),
  nextPath: z.string().min(1),
  expectedMtimeMs: z.number().finite().optional(),
});

const previewFileDiffSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["staged", "working"]),
});

const previewResetChangeSchema = z.object({
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
    if (error.statusCode === 409) {
      terminalPreviewLogger.warn("terminal-preview.file.mutation.conflict", {
        message: "Terminal preview file mutation conflict",
        statusCode: error.statusCode,
      });
    }
    res.status(error.statusCode).json({ message: error.message });
    return;
  }
  terminalPreviewLogger.error("terminal-preview.request.failed", {
    message: "Terminal preview request failed",
    error,
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

  router.put("/project/:id/preview/file", async (req, res) => {
    const parsed = previewSaveFileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
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
        await savePreviewFile({
          projectId: project.id,
          projectPath: project.path,
          requestedPath: parsed.data.path,
          content: parsed.data.content,
          expectedMtimeMs: parsed.data.expectedMtimeMs,
          overwrite: parsed.data.overwrite,
        }),
      );
    } catch (error) {
      handlePreviewError(res, error);
    }
  });

  router.delete("/project/:id/preview/file", async (req, res) => {
    const parsed = previewDeleteFileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
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
        await deletePreviewFile({
          projectId: project.id,
          projectPath: project.path,
          requestedPath: parsed.data.path,
          expectedMtimeMs: parsed.data.expectedMtimeMs,
        }),
      );
    } catch (error) {
      handlePreviewError(res, error);
    }
  });

  router.patch("/project/:id/preview/file/path", async (req, res) => {
    const parsed = previewRenameFileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
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
        await renamePreviewFile({
          projectId: project.id,
          projectPath: project.path,
          requestedPath: parsed.data.path,
          nextRequestedPath: parsed.data.nextPath,
          expectedMtimeMs: parsed.data.expectedMtimeMs,
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

  router.post("/project/:id/preview/git-change/reset", async (req, res) => {
    const parsed = previewResetChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
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
        await resetPreviewGitChange({
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

  router.get("/project/:id/preview/directory", async (req, res) => {
    const parsed = previewDirectorySchema.safeParse(req.query);
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
        await listPreviewDirectory({
          projectId: project.id,
          projectPath: project.path,
          relativePath: parsed.data.path,
          limit: parsed.data.limit,
        }),
      );
    } catch (error) {
      handlePreviewError(res, error);
    }
  });
}
