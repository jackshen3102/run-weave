import type { Router } from "express";
import type {
  TerminalProjectContextBranchStatus,
  TerminalProjectContextListItem,
} from "@runweave/shared/terminal/project-context";
import { z } from "zod";
import { BranchUpdatesTargetChangedError, HomeBranchStatusService } from "../../../terminal/git/home-branch-status";
import type {
  TerminalProjectContextRecord,
  TerminalSessionManager,
} from "../../../terminal/manager/manager";
import { logger } from "../../../logging/index";
import type { TerminalActivityDependencies } from "../../../terminal/runtime/activity-events";
import type { TerminalRuntimeRegistry } from "../../../terminal/runtime/registry";
import type { TerminalEventService } from "../../../terminal/state/terminal-event-service";
import type { TerminalStateService } from "../../../terminal/state/terminal-state-service";
import type { TmuxOutputWatcher } from "../../../terminal/tmux/output-watcher";
import type { TmuxService } from "../../../terminal/tmux/service";
import {
  TerminalWorktreeDeletionError,
  TerminalWorktreeDeletionService,
  type TerminalWorktreeDeletionOwnerHooks,
} from "../../../terminal/workspace-service/worktree-deletion";

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
  const branchStatusService = new HomeBranchStatusService();
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

  router.get("/project/:projectId/branch-updates", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const parsed = z.object({ refresh: z.enum(["true", "false"]).optional() }).strict().safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ message: "Invalid branch updates request" }); return; }
    const project = terminalSessionManager.getProject(req.params.projectId);
    if (!project) {
      res.status(terminalSessionManager.getProjectContext(req.params.projectId) ? 409 : 404)
        .json({ message: "Branch updates target unavailable" }); return;
    }
    if (!project.path) { res.status(409).json({ message: "Project path unavailable" }); return; }
    const directory = project.path;
    try {
      const value = await branchStatusService.branchUpdates({ kind: "project", projectId: project.id, path: directory }, parsed.data.refresh === "true");
      if (terminalSessionManager.getProject(project.id)?.path !== directory) throw new BranchUpdatesTargetChangedError();
      res.json(value);
    } catch (error) {
      res.status(error instanceof BranchUpdatesTargetChangedError ? 409 : 503).json({
        message: error instanceof BranchUpdatesTargetChangedError ? "读取目标已变化，请重新打开" : "主分支更新暂不可用",
        code: error instanceof BranchUpdatesTargetChangedError ? "branch_updates_target_changed" : "branch_updates_unavailable",
      });
    }
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

  // Git network work is separate from the frequently refreshed context list.
  router.post("/project/:parentProjectId/contexts/branch-status", async (req, res) => {
    const parsed = z.object({
      projectIds: z.array(z.string().min(1).max(2_000)).max(100),
    }).strict().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid branch status request" });
      return;
    }
    const contexts = await terminalSessionManager.refreshProjectContexts(req.params.parentProjectId);
    if (!contexts) {
      res.status(404).json({ message: "Terminal project not found" });
      return;
    }
    const ids = new Set(parsed.data.projectIds);
    const statuses = await Promise.all(contexts.filter((context) => ids.has(context.projectId))
      .map(async (context): Promise<TerminalProjectContextBranchStatus> => {
        const identity = { projectId: context.projectId, path: context.path, head: context.head };
        if (!context.path || context.availability !== "available") {
          return { ...identity, state: "unavailable" };
        }
        const { state, baseBranch, behind, checkedAt } =
          await branchStatusService.status(context.projectId, context.path);
        return { ...identity, state, baseBranch, behind, checkedAt };
      }));
    res.json({ statuses });
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
        const result = await deletionService.delete(
          req.params.parentProjectId,
          req.params.childProjectId,
        );
        if (result.cleanupWarnings.length > 0) {
          res.status(200).json(result);
        } else {
          res.status(204).send();
        }
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
