import type { Router, Response } from "express";
import { z } from "zod";
import {
  HANDOFF_PROMPT_BYTES,
  HANDOFF_TARGET_AGENTS,
} from "@runweave/shared/terminal/context-handoff";
import {
  HandoffConflict,
  type TerminalContextHandoffService,
} from "../../terminal/application/context-handoff";
import { TerminalConversationError } from "../../terminal/application/conversation";
import { sendTerminalPanelRouteError } from "./panels/common";

const schema = z
  .object({
    operationId: z.string().uuid(),
    panelId: z.string().min(1).max(200),
    expectedThreadId: z.string().min(1).max(200),
    expectedSourceRevision: z.string().min(1).max(128),
    targetAgent: z.enum(HANDOFF_TARGET_AGENTS),
    targetProjectId: z.string().min(1).max(1024),
    mode: z.enum(["native_fork", "portable_handoff"]),
    submitPrompt: z.boolean(),
    prompt: z
      .string()
      .refine(
        (text) =>
          Buffer.byteLength(text) <= HANDOFF_PROMPT_BYTES &&
          Buffer.from(text).toString() === text &&
          Array.from(text).every(
            (char) =>
              (char >= " " && char !== "\x7f") ||
              ["\t", "\r", "\n"].includes(char),
          ),
      )
      .default(""),
  })
  .strict();

function failure(res: Response, error: unknown) {
  if (error instanceof HandoffConflict)
    res
      .status(409)
      .json({
        code: error.code,
        message: error.message,
        details: error.details,
      });
  else if (error instanceof TerminalConversationError)
    res.status(error.status).json({
      code: error.status === 409 ? "handoff_source_changed" : error.code,
      message: error.message,
    });
  else if (!sendTerminalPanelRouteError(res, error))
    res.status(503).json({ message: "交接服务暂不可用" });
}

export function registerContextHandoffRoutes(
  router: Router,
  service: TerminalContextHandoffService,
) {
  router.get("/session/:id/agent/handoff-preview", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(await service.preview(req.params.id));
    } catch (error) {
      failure(res, error);
    }
  });
  router.post("/session/:id/agent/handoff", async (req, res) => {
    const input = schema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ message: "交接参数无效，新指令最多 32 KiB" });
      return;
    }
    try {
      res.status(201).json(await service.execute(req.params.id, input.data));
    } catch (error) {
      failure(res, error);
    }
  });
}
