import type { Router } from "express";
import type { TerminalProjectContextListItem } from "@runweave/shared/terminal/project-context";
import { z } from "zod";
import type {
  TerminalProjectContextRecord,
  TerminalSessionManager,
} from "../terminal/manager";

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
): void {
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
}
