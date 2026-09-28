import type { Router } from "express";
import { z } from "zod";
import type { ScheduledTaskService } from "../../../scheduled-tasks/service";
import { ScheduledTaskError } from "../../../scheduled-tasks/errors";
import type { CreateTerminalQuickInputRequest, ListTerminalQuickInputsResponse, UpdateTerminalQuickInputRequest } from "@runweave/shared/terminal/input";
import {
  TerminalQuickInputConflictError,
  TerminalQuickInputValidationError,
  type TerminalQuickInputService,
} from "../../../terminal/quick-input/service";

const quickInputModeSchema = z.enum([
  "line",
  "codex_slash_command",
  "prompt_paste",
]);

const listQuickInputsSchema = z.object({
  projectId: z.string().trim().min(1).optional(),
  scope: z.literal("global").optional(),
  order: z.literal("manual").optional(),
  cursor: z.string().min(1).optional(),
  q: z.string().optional(),
  kind: z.enum(["recent", "pinned", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).superRefine((value, context) => {
  if (value.scope && (value.projectId || value.kind !== "pinned" || value.order !== "manual")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Global scope requires pinned manual order" });
  }
  if (!value.scope && (value.order || value.cursor)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Manual order requires global scope" });
  }
});

const createQuickInputSchema = z
  .object({
    title: z.string().trim().max(120),
    data: z.string(),
    mode: quickInputModeSchema,
    projectId: z.string().trim().min(1).nullable().optional(),
    terminalSessionId: z.string().trim().min(1).nullable().optional(),
    cwd: z.string().trim().min(1).nullable().optional(),
    source: z.literal("ios_quick_reply").optional(),
    clientImportId: z.string().uuid().optional(),
  })
  .strict();

const updateQuickInputSchema = z
  .object({
    title: z.string().trim().max(120).optional(),
    pinned: z.boolean().optional(),
    data: z.string().optional(),
    mode: quickInputModeSchema.optional(),
    expectedUpdatedAt: z.string().datetime().optional(),
  })
  .strict();

export function registerTerminalQuickInputRoutes(
  router: Router,
  quickInputService: TerminalQuickInputService,
  scheduledTaskService?: ScheduledTaskService,
): void {
  if (scheduledTaskService) router.post("/quick-inputs/:id/run", async (req, res) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const body = z.object({
        projectId: z.string().trim().min(1),
        expectedInputUpdatedAt: z.string().datetime(),
      }).strict().parse(req.body);
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || !key.trim() || key.length > 200)
        throw new ScheduledTaskError("invalid_input", 400, "Idempotency-Key header is required");
      res.status(202).json(await scheduledTaskService.startQuickInput(
        id,
        body.projectId,
        body.expectedInputUpdatedAt,
        key.trim(),
        quickInputService,
      ));
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ code: "invalid_input", message: "Invalid quick input run request" });
      } else if (error instanceof ScheduledTaskError) {
        res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
      } else {
        res.status(500).json({ code: "quick_input_run_failed", message: "Quick input run failed" });
      }
    }
  });
  router.get("/quick-inputs", async (req, res) => {
    const parsed = listQuickInputsSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request query",
        errors: parsed.error.flatten(),
      });
      return;
    }

    try {
      const payload: ListTerminalQuickInputsResponse = parsed.data.scope === "global"
        ? await quickInputService.listPage(parsed.data)
        : { items: await quickInputService.list(parsed.data) };
      res.json(payload);
    } catch (error) {
      if (error instanceof TerminalQuickInputConflictError) {
        res.status(409).json({ code: error.code, message: error.message });
      } else if (error instanceof TerminalQuickInputValidationError) {
        res.status(400).json({ code: "invalid_input", message: error.message });
      } else {
        res.status(500).json({ code: "quick_input_list_failed", message: "Failed to list quick inputs" });
      }
    }
  });

  router.post("/quick-inputs", async (req, res) => {
    const parsed = createQuickInputSchema.safeParse(
      req.body as CreateTerminalQuickInputRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    try {
      const item = await quickInputService.createPinned(parsed.data);
      res.status(201).json(item);
    } catch (error) {
      if (error instanceof TerminalQuickInputValidationError) {
        res.status(400).json({ message: error.message });
        return;
      }
      res.status(500).json({
        message: "Failed to create terminal quick input",
        error: String(error),
      });
    }
  });

  router.patch("/quick-inputs/:id", async (req, res) => {
    const parsed = updateQuickInputSchema.safeParse(
      req.body as UpdateTerminalQuickInputRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    try {
      const item = await quickInputService.update(req.params.id, parsed.data);
      if (!item) {
        res.status(404).json({ message: "Terminal quick input not found" });
        return;
      }
      res.json(item);
    } catch (error) {
      if (error instanceof TerminalQuickInputConflictError) {
        res.status(409).json({ code: error.code, message: error.message });
      } else if (error instanceof TerminalQuickInputValidationError) {
        res.status(400).json({ code: "invalid_input", message: error.message });
      } else {
        res.status(500).json({ code: "quick_input_update_failed", message: "Failed to update quick input" });
      }
    }
  });

  router.post("/quick-inputs/:id/move", async (req, res) => {
    const parsed = z.object({
      beforeId: z.string().uuid().nullable(),
      expectedOrderVersion: z.string().length(64),
    }).strict().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: "invalid_input", message: "Invalid quick input move request" });
      return;
    }
    try {
      const orderVersion = await quickInputService.move(req.params.id, parsed.data.beforeId, parsed.data.expectedOrderVersion);
      res.json({ orderVersion });
    } catch (error) {
      if (error instanceof TerminalQuickInputConflictError) {
        res.status(409).json({ code: error.code, message: error.message });
      } else if (error instanceof TerminalQuickInputValidationError) {
        res.status(400).json({ code: "invalid_input", message: error.message });
      } else {
        res.status(500).json({ code: "quick_input_move_failed", message: "Failed to move quick input" });
      }
    }
  });

  router.delete("/quick-inputs/:id", async (req, res) => {
    const deleted = await quickInputService.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ message: "Terminal quick input not found" });
      return;
    }
    res.status(204).send();
  });

  router.post("/quick-inputs/:id/used", async (req, res) => {
    const item = await quickInputService.markUsed(req.params.id);
    if (!item) {
      res.status(404).json({ message: "Terminal quick input not found" });
      return;
    }
    res.json(item);
  });
}
