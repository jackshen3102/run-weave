import type { Response, Router } from "express";
import { z } from "zod";
import type {
  CreateTerminalProjectRequest,
  UpdateTerminalProjectRequest,
} from "@browser-viewer/shared";
import { logger } from "../logging";
import type { TerminalSessionManager } from "../terminal/manager";
import {
  clearPreviewFileSearchCache,
  normalizeProjectPath,
  TerminalPreviewError,
} from "../terminal/preview";
import { killTmuxSessionForTerminal } from "../terminal/runtime-launcher";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import type { TmuxService } from "../terminal/tmux-service";
import type { TmuxOutputWatcher } from "../terminal/tmux-output-watcher";
import { toProjectPayload } from "./terminal-route-payloads";

const terminalProjectLogger = logger.child({ component: "terminal" });

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

const reorderProjectsSchema = z
  .object({
    orderedIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

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

function handleProjectError(res: Response, error: unknown) {
  if (error instanceof TerminalPreviewError) {
    res.status(error.statusCode).json({ message: error.message });
    return;
  }
  terminalProjectLogger.error("terminal.project.request.failed", {
    message: "Terminal project request failed",
    error,
  });
  res.status(500).json({
    message: "Terminal project request failed",
    error: String(error),
  });
}

export function registerTerminalProjectRoutes(
  router: Router,
  terminalSessionManager: TerminalSessionManager,
  options?: {
    runtimeRegistry?: TerminalRuntimeRegistry;
    tmuxService?: TmuxService;
    tmuxOutputWatcher?: TmuxOutputWatcher;
  },
): void {
  router.get("/project", (_req, res) => {
    const payload = terminalSessionManager
      .listProjects()
      .map((project) => toProjectPayload(project));

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
      terminalProjectLogger.error("terminal.project.reorder.failed", {
        message: "Terminal project reorder failed",
        error,
      });
      res.status(500).json({
        message: "Terminal project reorder failed",
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
      await options?.tmuxOutputWatcher?.unwatchSession(session.id);
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
}
