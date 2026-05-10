import { Router, type Response } from "express";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
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
  SendTerminalInputRequest,
  SendTerminalInputResponse,
  TerminalCompletionEventListResponse,
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
} from "../terminal/default-shell";
import {
  clearPreviewFileSearchCache,
  normalizeProjectPath,
  TerminalPreviewError,
} from "../terminal/preview";
import { registerTerminalPreviewRoutes } from "./terminal-preview-routes";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import type { TerminalCompletionEventStore } from "../terminal/completion-events";
import {
  ensureTerminalRuntime,
  isTmuxBackedSession,
  killTmuxSessionForTerminal,
  readTerminalScrollback,
  readTerminalScrollbackCapture,
  resolveTmuxTarget,
} from "../terminal/runtime-launcher";
import type { TmuxService } from "../terminal/tmux-service";
import { buildTerminalMobileOverviewPayload } from "./terminal-mobile-overview";
import {
  toHistoryPayload,
  toProjectPayload,
  toSessionListItem,
  toStatusPayload,
} from "./terminal-route-payloads";

const createTerminalSessionSchema = z
  .object({
    projectId: z.string().trim().min(1).optional(),
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().trim().min(1).optional(),
    inheritFromTerminalSessionId: z.string().trim().min(1).optional(),
    runtimePreference: z.enum(["auto", "tmux", "pty"]).optional(),
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

const createTerminalClipboardImageSchema = z.object({
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  dataBase64: z.string().min(1),
});

const sendTerminalInputSchema = z
  .object({
    data: z.string(),
    operationId: z.string().trim().min(1).optional(),
  })
  .strict();

function buildTerminalInputOperationId(): string {
  return `op_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}_${randomBytes(4).toString("hex")}`;
}

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
    terminalSessionManager.listProjects().find((project) => project.isDefault)
      ?.id;
  const projectPath = projectId
    ? terminalSessionManager.getProject(projectId)?.path
    : undefined;
  const cwd =
    payload.cwd?.trim() ||
    (isExistingDirectory(inheritedCwd) ? inheritedCwd : undefined) ||
    projectPath ||
    os.homedir();

  return {
    projectId: payload.projectId,
    command,
    args: payload.args ?? resolveDefaultTerminalArgs(command),
    cwd,
  };
}

function isExistingDirectory(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    return existsSync(value) && statSync(value).isDirectory();
  } catch {
    return false;
  }
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

export function createTerminalRouter(
  terminalSessionManager: TerminalSessionManager,
  options?: {
    ptyService?: PtyService;
    runtimeRegistry?: TerminalRuntimeRegistry;
    tmuxService?: TmuxService;
    authService?: AuthService;
    completionEventStore?: TerminalCompletionEventStore;
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

  const handleProjectError = (res: Response, error: unknown) => {
    if (error instanceof TerminalPreviewError) {
      res.status(error.statusCode).json({ message: error.message });
      return;
    }
    console.error("[viewer-be] terminal project request failed", {
      error: String(error),
    });
    res.status(500).json({
      message: "Terminal project request failed",
      error: String(error),
    });
  };

  router.get("/project", (_req, res) => {
    const payload = terminalSessionManager
      .listProjects()
      .map((project) => toProjectPayload(project));

    res.json(payload);
  });

  registerTerminalPreviewRoutes(router, terminalSessionManager);

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
      handleProjectError(res, error);
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
      const project = await terminalSessionManager.updateProject(
        req.params.id,
        {
          name: parsed.data.name,
          ...(projectPath !== undefined ? { path: projectPath } : {}),
        },
      );
      if (!project) {
        res.status(404).json({ message: "Terminal project not found" });
        return;
      }

      clearPreviewFileSearchCache(project.id);
      res.json(toProjectPayload(project));
    } catch (error) {
      handleProjectError(res, error);
    }
  });

  const reorderProjectsSchema = z
    .object({
      orderedIds: z.array(z.string().min(1)).min(1),
    })
    .strict();

  router.put("/project/reorder", async (req, res) => {
    const parsed = reorderProjectsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    try {
      await terminalSessionManager.reorderProjects(parsed.data.orderedIds);
      res.status(204).send();
    } catch (error) {
      console.error("[viewer-be] terminal project reorder failed", {
        error: String(error),
      });
      res.status(500).json({
        message: "Terminal project reorder failed",
        error: String(error),
      });
    }
  });

  const reorderSessionsSchema = z
    .object({
      projectId: z.string().trim().min(1),
      orderedIds: z.array(z.string().min(1)).min(1),
    })
    .strict();

  router.put("/session/reorder", async (req, res) => {
    const parsed = reorderSessionsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    try {
      await terminalSessionManager.reorderSessions(
        parsed.data.projectId,
        parsed.data.orderedIds,
      );
      res.status(204).send();
    } catch (error) {
      console.error("[viewer-be] terminal session reorder failed", {
        error: String(error),
      });
      res.status(500).json({
        message: "Terminal session reorder failed",
        error: String(error),
      });
    }
  });

  router.delete("/project/:id", async (req, res) => {
    const childSessions = terminalSessionManager
      .listSessions()
      .filter((session) => session.projectId === req.params.id);

    if (options?.runtimeRegistry) {
      for (const session of childSessions) {
        await options.runtimeRegistry.disposeRuntime(session.id);
      }
    }
    for (const session of childSessions) {
      await killTmuxSessionForTerminal(session, options?.tmuxService);
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
    const payload = terminalSessionManager
      .listSessions()
      .map((session) => toSessionListItem(session));

    res.json(payload);
  });

  router.get("/mobile/overview", async (_req, res) => {
    try {
      res.json(
        await buildTerminalMobileOverviewPayload(
          terminalSessionManager,
          options?.tmuxService,
        ),
      );
    } catch (error) {
      console.error("[viewer-be] terminal mobile overview request failed", {
        error: String(error),
      });
      res.status(500).json({
        message: "Terminal mobile overview request failed",
        error: String(error),
      });
    }
  });

  router.get("/completion-events", (req, res) => {
    const after =
      typeof req.query.after === "string" && req.query.after.trim()
        ? req.query.after.trim()
        : null;
    const payload: TerminalCompletionEventListResponse = {
      events: options?.completionEventStore?.listAfter(after) ?? [],
    };
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
          let launchSession = session;
          const runtimePreference = parsed.data.runtimePreference ?? "auto";
          const shouldTryTmux =
            runtimePreference === "auto" || runtimePreference === "tmux";
          const tmuxAvailable =
            options.tmuxService && shouldTryTmux
              ? await options.tmuxService.isAvailable()
              : false;
          const tmuxUnavailableReason =
            options.tmuxService && shouldTryTmux && !tmuxAvailable
              ? await options.tmuxService.getUnavailableReason()
              : null;

          if (options.tmuxService && shouldTryTmux && tmuxAvailable) {
            const target = options.tmuxService.buildTarget(session.id);
            launchSession =
              (await terminalSessionManager.updateRuntimeMetadata(session.id, {
                runtimeKind: "tmux",
                tmuxSessionName: target.sessionName,
                tmuxSocketPath: target.socketPath,
                recoverable: true,
              })) ?? session;
          } else if (options.tmuxService && shouldTryTmux) {
            launchSession =
              (await terminalSessionManager.updateRuntimeMetadata(session.id, {
                runtimeKind: "pty",
                tmuxUnavailableReason:
                  tmuxUnavailableReason ?? "tmux unavailable",
                recoverable: false,
              })) ?? session;
          }

          await ensureTerminalRuntime({
            session: launchSession,
            terminalSessionManager,
            runtimeRegistry: options.runtimeRegistry,
            ptyService: options.ptyService,
            tmuxService: options.tmuxService,
            allowMissingTmuxSession: true,
          });
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

    const historyScrollback = await readTerminalScrollbackCapture(
      session,
      terminalSessionManager,
      options?.tmuxService,
      "history",
    );

    res.json(
      toHistoryPayload(
        session,
        historyScrollback.data,
        historyScrollback.sourceCols,
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
        await readTerminalScrollback(
          session,
          terminalSessionManager,
          options?.tmuxService,
          "live",
        ),
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

  router.post("/session/:id/input", async (req, res) => {
    const parsed = sendTerminalInputSchema.safeParse(
      req.body as SendTerminalInputRequest,
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
    if (session.status !== "running") {
      res.status(409).json({ message: "Terminal session is not running" });
      return;
    }
    if (!options?.runtimeRegistry || !options.ptyService) {
      res.status(503).json({ message: "Terminal runtime service unavailable" });
      return;
    }
    if (isTmuxBackedSession(session) && !options.tmuxService) {
      res.status(503).json({ message: "Terminal tmux service unavailable" });
      return;
    }

    try {
      const ensured = await ensureTerminalRuntime({
        session,
        terminalSessionManager,
        runtimeRegistry: options.runtimeRegistry,
        ptyService: options.ptyService,
        tmuxService: options.tmuxService,
      });
      if (isTmuxBackedSession(session) && options.tmuxService) {
        await options.tmuxService.sendInput(
          resolveTmuxTarget(session, options.tmuxService),
          parsed.data.data,
        );
      } else {
        ensured.runtime.write(parsed.data.data);
      }
      const payload: SendTerminalInputResponse = {
        operationId: parsed.data.operationId ?? buildTerminalInputOperationId(),
        terminalSessionId: session.id,
        inputAccepted: true,
        inputEnqueued: true,
        runtimeKind: isTmuxBackedSession(session) ? "tmux" : "pty",
        acceptedAt: new Date().toISOString(),
      };
      res.status(200).json(payload);
    } catch (error) {
      console.error("[viewer-be] terminal input failed", {
        terminalSessionId: session.id,
        error: String(error),
      });
      res.status(500).json({
        message: "Terminal input failed",
        error: String(error),
      });
    }
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
    const session = terminalSessionManager.getSession(req.params.id);
    if (options?.runtimeRegistry) {
      await options.runtimeRegistry.disposeRuntime(req.params.id);
    }
    if (session) {
      await killTmuxSessionForTerminal(session, options?.tmuxService);
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
