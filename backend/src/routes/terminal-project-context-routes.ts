import type { Router } from "express";
import type { TerminalProjectContextListItem } from "@runweave/shared/terminal/project-context";
import { z } from "zod";
import type {
  TerminalProjectContextRecord,
  TerminalSessionManager,
} from "../terminal/manager/manager";
import { logger } from "../logging";
import type { TerminalActivityDependencies } from "../terminal/activity-events";
import type { TerminalRuntimeRegistry } from "../terminal/runtime/registry";
import type { TerminalEventService } from "../terminal/state/terminal-event-service";
import type { TerminalStateService } from "../terminal/state/terminal-state-service";
import type { TmuxOutputWatcher } from "../terminal/tmux/output-watcher";
import type { TmuxService } from "../terminal/tmux/service";
import {
  TerminalWorktreeDeletionError,
  TerminalWorktreeDeletionService,
  type TerminalWorktreeDeletionOwnerHooks,
} from "../terminal/worktree-deletion";

const terminalProjectContextLogger = logger.child({
  component: "terminal-project-context",
});

const updateProjectContextSchema = z
  .object({ pinned: z.boolean() })
  .strict();

function toProjectContextPayload(
  context: TerminalProjectContextRecord,
): TerminalProjectContextListItem {
  return {
    projectId: context.projectId,
    parentProjectId: context.parentProjectId,
    name: context.name,
    branch: context.branch,
    head: context.head,
    path: context.path,
    isPrimary: context.isPrimary,
    pinned: context.pinned,
    pinOrder: context.pinOrder,
    availability: context.availability,
  };
}

export function registerTerminalProjectContextRoutes(
  router: Router,
  terminalSessionManager: TerminalSessionManager,
  options?: {
    runtimeRegistry?: TerminalRuntimeRegistry;
    terminalStateService?: TerminalStateService;
    terminalEventService?: TerminalEventService;
    tmuxService?: TmuxService;
    tmuxOutputWatcher?: TmuxOutputWatcher;
    activity?: TerminalActivityDependencies;
    ownerHooks?: TerminalWorktreeDeletionOwnerHooks;
  },
): void {
  const deletionService = new TerminalWorktreeDeletionService({
    terminalSessionManager,
    runtimeRegistry: options?.runtimeRegistry,
    terminalStateService: options?.terminalStateService,
    terminalEventService: options?.terminalEventService,
    tmuxService: options?.tmuxService,
    tmuxOutputWatcher: options?.tmuxOutputWatcher,
    activity: options?.activity,
    ownerHooks: options?.ownerHooks,
  });

  router.get("/project/:parentProjectId/contexts", async (req, res) => {
    const contexts = await terminalSessionManager.refreshProjectContexts(
      req.params.parentProjectId,
    );
    if (!contexts) {
      res.status(404).json({ message: "Terminal project not found" });
      return;
    }
    res.json(contexts.map(toProjectContextPayload));
  });

  router.patch(
    "/project/:parentProjectId/contexts/:childProjectId",
    async (req, res) => {
      const parsed = updateProjectContextSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          message: "Invalid request body",
          errors: parsed.error.flatten(),
        });
        return;
      }
      const context = await terminalSessionManager.setProjectContextPinned(
        req.params.parentProjectId,
        req.params.childProjectId,
        parsed.data.pinned,
      );
      if (!context) {
        res.status(404).json({ message: "Terminal project context not found" });
        return;
      }
      res.json(toProjectContextPayload(context));
    },
  );

  router.delete(
    "/project/:parentProjectId/contexts/:childProjectId",
    async (req, res) => {
      try {
        await deletionService.delete(
          req.params.parentProjectId,
          req.params.childProjectId,
        );
        res.status(204).send();
      } catch (error) {
        if (error instanceof TerminalWorktreeDeletionError) {
          res.status(error.statusCode).json({
            message: error.message,
            ...(error.code ? { code: error.code } : {}),
          });
          return;
        }
        terminalProjectContextLogger.error("terminal.worktree.delete.failed", {
          message: "Worktree deletion failed",
          parentProjectId: req.params.parentProjectId,
          childProjectId: req.params.childProjectId,
          error,
        });
        res.status(500).json({ message: "Worktree deletion failed" });
      }
    },
  );
}
