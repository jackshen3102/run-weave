import { Router } from "express";
import { z } from "zod";
import type {
  CreateTerminalSessionRequest,
  CreateTerminalSessionResponse,
  TerminalSessionListItem,
  TerminalSessionStatusResponse,
} from "@browser-viewer/shared";
import type { TerminalSessionManager } from "../terminal/manager";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";

const createTerminalSessionSchema = z.object({
  name: z.string().trim().min(1).optional(),
  command: z.string().trim().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().trim().min(1),
  linkedBrowserSessionId: z.string().trim().min(1).optional(),
});

const updateTerminalSessionSchema = z.object({
  name: z.string().trim().min(1),
});

function toStatusPayload(
  session: ReturnType<TerminalSessionManager["getSession"]> extends infer T
    ? NonNullable<T>
    : never,
): TerminalSessionStatusResponse {
  return {
    terminalSessionId: session.id,
    name: session.name,
    command: session.command,
    args: session.args,
    cwd: session.cwd,
    linkedBrowserSessionId: session.linkedBrowserSessionId,
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    exitCode: session.exitCode,
  };
}

export function createTerminalRouter(
  terminalSessionManager: TerminalSessionManager,
  options?: {
    ptyService?: PtyService;
    runtimeRegistry?: TerminalRuntimeRegistry;
  },
): Router {
  const router = Router();

  router.get("/session", (_req, res) => {
    const payload: TerminalSessionListItem[] = terminalSessionManager
      .listSessions()
      .map((session) => ({
        terminalSessionId: session.id,
        name: session.name,
        command: session.command,
        args: session.args,
        cwd: session.cwd,
        linkedBrowserSessionId: session.linkedBrowserSessionId,
        status: session.status,
        createdAt: session.createdAt.toISOString(),
        lastActivityAt: session.lastActivityAt.toISOString(),
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
      const session = await terminalSessionManager.createSession(parsed.data);
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
