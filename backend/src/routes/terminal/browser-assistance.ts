import type { Router, Response } from "express";
import { z } from "zod";
import {
  BrowserAssistanceError,
  BrowserAssistanceService,
} from "../../terminal/browser-assistance/service";
import type { TerminalSessionManager } from "../../terminal/manager/manager";
import type { TmuxService } from "../../terminal/tmux/service";

const createSchema = z
  .object({
    panelId: z.string().trim().min(1).max(512),
    profileId: z.enum(["profile-1", "profile-2", "profile-3"]),
    browserGroupId: z.string().trim().min(1).max(512),
    targetId: z.string().trim().min(1).max(512),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

function fail(res: Response, error: unknown) {
  res
    .status(error instanceof BrowserAssistanceError ? error.status : 500)
    .json({
      message:
        error instanceof BrowserAssistanceError
          ? error.message
          : "Browser assistance failed",
    });
}

export function registerBrowserAssistanceRoutes(
  router: Router,
  manager: TerminalSessionManager,
  options?: { tmuxService?: TmuxService },
) {
  const service = new BrowserAssistanceService(manager, options?.tmuxService);
  const path = "/session/:id/browser-assistance";
  router.get(path, (req, res) => res.json(service.list(req.params.id)));
  router.post(path, (req, res) => {
    const input = createSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ message: "Invalid assistance request" });
      return;
    }
    try {
      res.status(201).json(service.create(req.params.id, input.data));
    } catch (error) {
      fail(res, error);
    }
  });
  router.get(`${path}/:requestId`, (req, res) => {
    try {
      res.json(service.get(req.params.id, req.params.requestId));
    } catch (error) {
      fail(res, error);
    }
  });
  router.post(`${path}/:requestId/:action`, async (req, res) => {
    try {
      const { id, requestId, action } = req.params;
      if (action === "resume") res.json(await service.resume(id, requestId));
      else if (action === "cancel") res.json(service.cancel(id, requestId));
      else if (
        action === "acknowledge" &&
        typeof req.body?.panelId === "string"
      ) {
        res.json(service.acknowledge(id, requestId, req.body.panelId));
      } else res.status(400).json({ message: "Invalid assistance action" });
    } catch (error) {
      fail(res, error);
    }
  });
}
