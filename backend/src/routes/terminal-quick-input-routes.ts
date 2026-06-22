import type { Router } from "express";
import { z } from "zod";
import type {
  CreateTerminalQuickInputRequest,
  ListTerminalQuickInputsResponse,
  UpdateTerminalQuickInputRequest,
} from "@runweave/shared";
import {
  TerminalQuickInputValidationError,
  type TerminalQuickInputService,
} from "../terminal/quick-input-service";

const quickInputModeSchema = z.enum([
  "line",
  "codex_slash_command",
  "prompt_paste",
]);

const listQuickInputsSchema = z.object({
  projectId: z.string().trim().min(1).optional(),
  q: z.string().optional(),
  kind: z.enum(["recent", "pinned", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const createQuickInputSchema = z
  .object({
    title: z.string().trim().max(120),
    data: z.string(),
    mode: quickInputModeSchema,
    projectId: z.string().trim().min(1).nullable().optional(),
    terminalSessionId: z.string().trim().min(1).nullable().optional(),
    cwd: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

const updateQuickInputSchema = z
  .object({
    title: z.string().trim().max(120).optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

export function registerTerminalQuickInputRoutes(
  router: Router,
  quickInputService: TerminalQuickInputService,
): void {
  router.get("/quick-inputs", async (req, res) => {
    const parsed = listQuickInputsSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request query",
        errors: parsed.error.flatten(),
      });
      return;
    }

    const payload: ListTerminalQuickInputsResponse = {
      items: await quickInputService.list(parsed.data),
    };
    res.json(payload);
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

    const item = await quickInputService.update(req.params.id, parsed.data);
    if (!item) {
      res.status(404).json({ message: "Terminal quick input not found" });
      return;
    }
    res.json(item);
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
