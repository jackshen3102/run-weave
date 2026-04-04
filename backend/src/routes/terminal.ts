import { Router } from "express";
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
  TerminalSessionListItem,
  TerminalSessionStatusResponse,
  UpdateTerminalProjectRequest,
} from "@browser-viewer/shared";
import type { AuthService } from "../auth/service";
import type { TerminalSessionManager } from "../terminal/manager";
import {
  TERMINAL_CLIPBOARD_IMAGE_MAX_BYTES,
  TERMINAL_CLIPBOARD_IMAGE_MAX_MIB,
} from "../terminal/clipboard-image";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";

const createTerminalSessionSchema = z.object({
  projectId: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  command: z.string().trim().min(1).optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().trim().min(1).optional(),
}).strict();

const createTerminalProjectSchema = z.object({
  name: z.string().trim().min(1),
}).strict();

const updateTerminalProjectSchema = z.object({
  name: z.string().trim().min(1),
}).strict();

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

function resolveDefaultTerminalCommand(): string {
  if (process.platform === "win32") {
    const configured = process.env.COMSPEC?.trim();
    if (configured) {
      return configured;
    }
    return "powershell.exe";
  }

  const configured = process.env.SHELL?.trim();
  if (configured) {
    return configured;
  }

  return "/bin/bash";
}

function resolveTerminalCreateDefaults(payload: CreateTerminalSessionRequest): {
  projectId?: string;
  name?: string;
  command: string;
  args?: string[];
  cwd: string;
} {
  const command = payload.command?.trim() || resolveDefaultTerminalCommand();
  const cwd = payload.cwd?.trim() || os.homedir();

  return {
    projectId: payload.projectId,
    name: payload.name,
    command,
    args: payload.args,
    cwd,
  };
}

function toStatusPayload(
  session: ReturnType<TerminalSessionManager["getSession"]> extends infer T
    ? NonNullable<T>
    : never,
): TerminalSessionStatusResponse {
  return {
    terminalSessionId: session.id,
    projectId: session.projectId,
    name: session.name,
    command: session.command,
    args: session.args,
    cwd: session.cwd,
    scrollback: session.scrollback,
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    exitCode: session.exitCode,
  };
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

  router.get("/project", (_req, res) => {
    const payload: TerminalProjectListItem[] = terminalSessionManager
      .listProjects()
      .map((project) => ({
        projectId: project.id,
        name: project.name,
        createdAt: project.createdAt.toISOString(),
        isDefault: project.isDefault,
      }));

    res.json(payload);
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

    const project = await terminalSessionManager.createProject(parsed.data.name);
    res.status(201).json({
      projectId: project.id,
      name: project.name,
      createdAt: project.createdAt.toISOString(),
      isDefault: project.isDefault,
    } satisfies TerminalProjectListItem);
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

    const project = await terminalSessionManager.updateProject(
      req.params.id,
      parsed.data.name,
    );
    if (!project) {
      res.status(404).json({ message: "Terminal project not found" });
      return;
    }

    res.json({
      projectId: project.id,
      name: project.name,
      createdAt: project.createdAt.toISOString(),
      isDefault: project.isDefault,
    } satisfies TerminalProjectListItem);
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
        resolveTerminalCreateDefaults(parsed.data),
      );
      if (options?.ptyService && options.runtimeRegistry) {
        try {
          const runtime = options.ptyService.spawnSession({
            command: session.command,
            args: session.args,
            cwd: session.cwd,
          });
          options.runtimeRegistry.createRuntime(session.id, runtime);
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

  router.get("/session/:id", (req, res) => {
    const session = terminalSessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }

    res.json(toStatusPayload(session));
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

    const issued = options.authService.issueTemporaryToken("terminal", 60_000);
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
      const terminalTempDir = path.join(os.tmpdir(), "browser-viewer-terminal-images");
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
