import { Router, type Response } from "express";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  CreateTerminalProjectRequest,
  CreateTerminalClipboardImageRequest,
  CreateTerminalClipboardImageResponse,
  CreateTerminalSessionRequest,
  CreateTerminalSessionResponse,
  CreateTerminalWsTicketResponse,
  TerminalProjectListItem,
  TerminalSessionHistoryResponse,
  TerminalSessionListItem,
  TerminalSessionStatusResponse,
  UpdateTerminalProjectRequest,
} from "@browser-viewer/shared";
import type { AuthService } from "../auth/service";
import { readBearerToken } from "../auth/middleware";
import type { TerminalSessionManager } from "../terminal/manager";
import {
  TERMINAL_CLIPBOARD_IMAGE_MAX_BYTES,
  TERMINAL_CLIPBOARD_IMAGE_MAX_MIB,
} from "../terminal/clipboard-image";
import {
  resolveDefaultTerminalArgs,
  resolveDefaultTerminalCommand,
  resolveTerminalFallbackLaunchConfig,
} from "../terminal/default-shell";
import {
  clearPreviewFileSearchCache,
  getPreviewFileDiff,
  getPreviewGitChanges,
  normalizeProjectPath,
  readPreviewFile,
  searchPreviewFiles,
  TerminalPreviewError,
} from "../terminal/preview";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import { createTerminalRuntimeRecorder } from "../terminal/runtime-recorder";

const createTerminalSessionSchema = z
  .object({
    projectId: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().trim().min(1).optional(),
    inheritFromTerminalSessionId: z.string().trim().min(1).optional(),
  })
  .strict();

const createTerminalProjectSchema = z
  .object({
    name: z.string().trim().min(1),
    path: z.string().nullable().optional(),
  })
  .strict();

const updateTerminalProjectSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    path: z.string().nullable().optional(),
  })
  .strict()
  .refine((payload) => payload.name !== undefined || "path" in payload, {
    message: "Project name or path is required",
  });

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

const updateTerminalSessionSchema = z.object({
  name: z.string().trim().min(1),
});

const createTerminalClipboardImageSchema = z.object({
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  dataBase64: z.string().min(1),
});

function resolveClipboardImageExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      throw new Error(`Unsupported clipboard image mime type: ${mimeType}`);
  }
}

function buildClipboardImageFileName(
  now: Date,
  extension: string,
  randomHex = randomBytes(3).toString("hex"),
): string {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  const time = now.toISOString().slice(11, 19).replaceAll(":", "");
  return `browser-viewer-terminal-image-${date}-${time}-${randomHex}.${extension}`;
}

function resolveTerminalCreateDefaults(
  payload: CreateTerminalSessionRequest,
  terminalSessionManager: TerminalSessionManager,
): {
  projectId?: string;
  name?: string;
  command: string;
  args?: string[];
  cwd: string;
} {
  const command = payload.command?.trim() || resolveDefaultTerminalCommand();
  const inheritedCwd = payload.inheritFromTerminalSessionId
    ? terminalSessionManager.getSession(payload.inheritFromTerminalSessionId)
        ?.cwd
    : undefined;
  const projectId =
    payload.projectId ??
    terminalSessionManager.listProjects().find((project) => project.isDefault)?.id;
  const projectPath = projectId
    ? terminalSessionManager.getProject(projectId)?.path
    : undefined;
  const cwd = payload.cwd?.trim() || inheritedCwd || projectPath || os.homedir();

  return {
    projectId: payload.projectId,
    name: payload.name,
    command,
    args: payload.args ?? resolveDefaultTerminalArgs(command),
    cwd,
  };
}

function toProjectPayload(
  project: ReturnType<TerminalSessionManager["getProject"]> extends infer T
    ? NonNullable<T>
    : never,
): TerminalProjectListItem {
  return {
    projectId: project.id,
    name: project.name,
    path: project.path ?? null,
    createdAt: project.createdAt.toISOString(),
    isDefault: project.isDefault,
  };
}

async function resolveProjectPathInput(
  rawPath: string | null | undefined,
): Promise<string | null | undefined> {
  if (rawPath === undefined) {
    return undefined;
  }
  if (rawPath === null || rawPath.trim() === "") {
    return null;
  }
  const normalized = await normalizeProjectPath(rawPath);
  if (!normalized) {
    throw new TerminalPreviewError(
      "Project path must be a readable directory",
      400,
    );
  }
  return normalized;
}

function toStatusPayload(
  session: ReturnType<TerminalSessionManager["getSession"]> extends infer T
    ? NonNullable<T>
    : never,
  scrollback = session.scrollback,
): TerminalSessionStatusResponse {
  return {
    terminalSessionId: session.id,
    projectId: session.projectId,
    name: session.name,
    command: session.command,
    args: session.args,
    cwd: session.cwd,
    scrollback,
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    exitCode: session.exitCode,
  };
}

function toHistoryPayload(
  session: ReturnType<TerminalSessionManager["getSession"]> extends infer T
    ? NonNullable<T>
    : never,
  scrollback: string,
): TerminalSessionHistoryResponse {
  return toStatusPayload(session, scrollback);
}

export function createTerminalRouter(
  terminalSessionManager: TerminalSessionManager,
  options?: {
    ptyService?: PtyService;
    runtimeRegistry?: TerminalRuntimeRegistry;
    authService?: AuthService;
  },
): Router {
  const router = Router();

  const resolveAuthenticatedSessionId = (
    authorizationHeader: string | undefined,
  ) => {
    if (!options?.authService) {
      return null;
    }
    const token = readBearerToken({
      headers: { authorization: authorizationHeader },
    } as never);
    if (!token) {
      return null;
    }
    return options.authService.verifyAccessToken(token)?.sessionId ?? null;
  };

  const resolveProjectPreviewContext = (projectId: string) => {
    const project = terminalSessionManager.getProject(projectId);
    if (!project) {
      throw new TerminalPreviewError("Terminal project not found", 404);
    }
    return { project };
  };

  const handlePreviewError = (res: Response, error: unknown) => {
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
  };

  router.get("/project", (_req, res) => {
    const payload: TerminalProjectListItem[] = terminalSessionManager
      .listProjects()
      .map((project) => toProjectPayload(project));

    res.json(payload);
  });

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
      const { project } = resolveProjectPreviewContext(req.params.id);
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
      const { project } = resolveProjectPreviewContext(req.params.id);
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

  router.get("/project/:id/preview/git-changes", async (req, res) => {
    try {
      const { project } = resolveProjectPreviewContext(req.params.id);
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
      const { project } = resolveProjectPreviewContext(req.params.id);
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

  router.post("/project", async (req, res) => {
    const parsed = createTerminalProjectSchema.safeParse(
      req.body as CreateTerminalProjectRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    try {
      const projectPath = await resolveProjectPathInput(parsed.data.path);
      const project = await terminalSessionManager.createProject(
        parsed.data.name,
        projectPath ?? null,
      );
      res.status(201).json(toProjectPayload(project));
    } catch (error) {
      handlePreviewError(res, error);
    }
  });

  router.patch("/project/:id", async (req, res) => {
    const parsed = updateTerminalProjectSchema.safeParse(
      req.body as UpdateTerminalProjectRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    try {
      const projectPath = await resolveProjectPathInput(parsed.data.path);
      const project = await terminalSessionManager.updateProject(req.params.id, {
        name: parsed.data.name,
        ...(projectPath !== undefined ? { path: projectPath } : {}),
      });
      if (!project) {
        res.status(404).json({ message: "Terminal project not found" });
        return;
      }

      clearPreviewFileSearchCache(project.id);
      res.json(toProjectPayload(project));
    } catch (error) {
      handlePreviewError(res, error);
    }
  });

  router.delete("/project/:id", async (req, res) => {
    if (options?.runtimeRegistry) {
      const childSessionIds = terminalSessionManager
        .listSessions()
        .filter((session) => session.projectId === req.params.id)
        .map((session) => session.id);

      for (const terminalSessionId of childSessionIds) {
        await options.runtimeRegistry.disposeRuntime(terminalSessionId);
      }
    }

    const deleted = await terminalSessionManager.deleteProject(req.params.id);
    if (!deleted) {
      res.status(404).json({ message: "Terminal project not found" });
      return;
    }

    clearPreviewFileSearchCache(req.params.id);
    res.status(204).send();
  });

  router.get("/session", (_req, res) => {
    const payload: TerminalSessionListItem[] = terminalSessionManager
      .listSessions()
      .map((session) => ({
        terminalSessionId: session.id,
        projectId: session.projectId,
        name: session.name,
        command: session.command,
        args: session.args,
        cwd: session.cwd,
        status: session.status,
        createdAt: session.createdAt.toISOString(),
        exitCode: session.exitCode,
      }));

    res.json(payload);
  });

  router.post("/session", async (req, res) => {
    const parsed = createTerminalSessionSchema.safeParse(
      req.body as CreateTerminalSessionRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    try {
      const session = await terminalSessionManager.createSession(
        resolveTerminalCreateDefaults(parsed.data, terminalSessionManager),
      );
      if (options?.ptyService && options.runtimeRegistry) {
        try {
          const runtime = options.ptyService.spawnSession({
            command: session.command,
            args: session.args,
            cwd: session.cwd,
            fallback: resolveTerminalFallbackLaunchConfig({
              command: session.command,
              args: session.args,
            }),
            onFallbackActivated: (fallback) => {
              void terminalSessionManager.updateSessionLaunch(
                session.id,
                fallback,
              );
            },
          });
          options.runtimeRegistry.createRuntime(session.id, runtime);
          options.runtimeRegistry.ensureRecorder(
            session.id,
            createTerminalRuntimeRecorder(terminalSessionManager, session.id),
          );
        } catch (error) {
          await terminalSessionManager.destroySession(session.id);
          throw error;
        }
      }
      const payload: CreateTerminalSessionResponse = {
        terminalSessionId: session.id,
        terminalUrl: `/terminal/${session.id}`,
      };
      res.status(201).json(payload);
    } catch (error) {
      console.error("[viewer-be] create terminal session failed", {
        error: String(error),
      });
      res.status(500).json({
        message: "Failed to create terminal session",
        error: String(error),
      });
    }
  });

  router.get("/session/:id/history", async (req, res) => {
    const session = terminalSessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }

    res.json(
      toHistoryPayload(
        session,
        await terminalSessionManager.readScrollback(req.params.id),
      ),
    );
  });

  router.get("/session/:id", async (req, res) => {
    const session = terminalSessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }

    res.json(
      toStatusPayload(
        session,
        await terminalSessionManager.readLiveScrollback(req.params.id),
      ),
    );
  });

  router.post("/session/:id/ws-ticket", (req, res) => {
    const session = terminalSessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }
    if (!options?.authService) {
      res.status(503).json({ message: "Terminal ticket service unavailable" });
      return;
    }
    const authSessionId = resolveAuthenticatedSessionId(
      req.headers.authorization,
    );
    if (!authSessionId) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const issued = options.authService.issueTemporaryToken({
      sessionId: authSessionId,
      tokenType: "terminal-ws",
      resource: { terminalSessionId: session.id },
      ttlMs: 60_000,
    });
    const payload: CreateTerminalWsTicketResponse = {
      ticket: issued.token,
      expiresIn: issued.expiresIn,
    };
    res.status(200).json(payload);
  });

  router.patch("/session/:id", async (req, res) => {
    const parsed = updateTerminalSessionSchema.safeParse(req.body as unknown);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    const session = await terminalSessionManager.updateSessionName(
      req.params.id,
      parsed.data.name,
    );
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }

    res.json(toStatusPayload(session));
  });

  router.post("/session/:id/clipboard-image", async (req, res) => {
    const parsed = createTerminalClipboardImageSchema.safeParse(
      req.body as CreateTerminalClipboardImageRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    const session = terminalSessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }

    try {
      const extension = resolveClipboardImageExtension(parsed.data.mimeType);
      const fileName = buildClipboardImageFileName(new Date(), extension);
      const terminalTempDir = path.join(
        os.tmpdir(),
        "browser-viewer-terminal-images",
      );
      const filePath = path.join(terminalTempDir, fileName);
      const imageBuffer = Buffer.from(parsed.data.dataBase64, "base64");
      if (imageBuffer.length > TERMINAL_CLIPBOARD_IMAGE_MAX_BYTES) {
        res.status(413).json({
          message: `Clipboard image exceeds ${TERMINAL_CLIPBOARD_IMAGE_MAX_MIB} MiB limit`,
        });
        return;
      }

      await mkdir(terminalTempDir, { recursive: true });
      await writeFile(filePath, imageBuffer);

      const payload: CreateTerminalClipboardImageResponse = {
        fileName,
        filePath,
      };
      res.status(201).json(payload);
    } catch (error) {
      console.error("[viewer-be] store terminal clipboard image failed", {
        terminalSessionId: req.params.id,
        error: String(error),
      });
      res.status(500).json({
        message: "Failed to store terminal clipboard image",
        error: String(error),
      });
    }
  });

  router.delete("/session/:id", async (req, res) => {
    if (options?.runtimeRegistry) {
      await options.runtimeRegistry.disposeRuntime(req.params.id);
    }
    const deleted = await terminalSessionManager.destroySession(req.params.id);
    if (!deleted) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }

    res.status(204).send();
  });

  return router;
}
