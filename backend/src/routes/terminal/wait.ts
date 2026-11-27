import type { Response, Router } from "express";
import { z } from "zod";
import type {
  TerminalSendAndWaitRequest,
  TerminalWaitOutputRequest,
} from "@runweave/shared/terminal/wait";
import { readBearerToken } from "../../auth/middleware";
import type { AuthService } from "../../auth/service";
import { logger } from "../../logging/index";
import { isMissingTerminalRuntimeError } from "../../terminal/application/input-dispatcher";
import { TerminalInputSubmissionError } from "../../terminal/application/submit-input";
import {
  TerminalWaitError,
  type TerminalWaitService,
} from "../../terminal/application/terminal-wait-service";
import type { TerminalSessionManager } from "../../terminal/manager/manager";
import { sendTerminalPanelRouteError } from "./panels/common";

const terminalLogger = logger.child({ component: "terminal-wait" });

const sendAndWaitSchema = z
  .object({
    operationId: z.string().trim().min(1).max(256),
    data: z.string().max(262_144),
    panelId: z.string().trim().min(1).max(200).optional(),
    panelAlias: z.string().trim().min(1).max(200).optional(),
    role: z.string().trim().min(1).max(200).optional(),
    mode: z
      .enum([
        "raw",
        "line",
        "codex_slash_command",
        "prompt_paste",
        "prompt_replace",
        "tmux_exit_copy_mode",
      ])
      .optional(),
    submit: z.boolean().optional(),
    wait: z
      .object({
        until: z.array(z.enum(["idle", "blocked"])).min(1).max(2).optional(),
        timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
        activityGateMs: z.number().int().min(100).max(30_000).optional(),
        rejectIfBlocked: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

const waitOutputSchema = z
  .object({
    panelId: z.string().trim().min(1).max(200).optional(),
    panelAlias: z.string().trim().min(1).max(200).optional(),
    role: z.string().trim().min(1).max(200).optional(),
    match: z.string().min(1).max(4_096).optional(),
    regex: z.string().min(1).max(4_096).optional(),
    lines: z.number().int().min(1).max(1_000).optional(),
    unwrap: z.boolean().optional(),
    timeoutMs: z.number().int().min(0).max(300_000).optional(),
  })
  .strict();

function bindRequestAbortController(
  res: Response,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  };
  res.on("close", onClose);
  return {
    signal: controller.signal,
    dispose: () => {
      res.off("close", onClose);
    },
  };
}

function sendWaitRouteError(
  res: Response,
  terminalSessionManager: TerminalSessionManager,
  terminalSessionId: string,
  error: unknown,
): void {
  if (res.headersSent) {
    return;
  }
  if (error instanceof TerminalWaitError) {
    res.status(error.status).json({
      code: error.code,
      message: error.message,
      ...(error.details ?? {}),
    });
    return;
  }
  if (error instanceof TerminalInputSubmissionError) {
    res.status(error.status).json({ message: error.message });
    return;
  }
  if (sendTerminalPanelRouteError(res, error)) {
    return;
  }
  const session = terminalSessionManager.getSession(terminalSessionId);
  if (session && isMissingTerminalRuntimeError(error)) {
    terminalSessionManager.markExited(session.id, session.exitCode);
    res.status(409).json({
      code: "SESSION_NOT_RUNNING",
      message: "Terminal session is not running",
      error: String(error),
    });
    return;
  }
  terminalLogger.error("terminal.wait.route.failed", {
    message: "Terminal wait route failed",
    terminalSessionId,
    error,
  });
  res.status(500).json({
    message: "Terminal wait request failed",
    error: String(error),
  });
}

export function registerTerminalWaitRoutes(
  router: Router,
  terminalSessionManager: TerminalSessionManager,
  waitService: TerminalWaitService,
  authService?: AuthService,
): void {
  router.post("/session/:id/send-and-wait", async (req, res) => {
    const parsed = sendAndWaitSchema.safeParse(
      req.body as TerminalSendAndWaitRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        code: "INVALID_REQUEST",
        message: "Invalid request body",
        details: parsed.error.flatten(),
      });
      return;
    }

    const identity = authService?.verifyAccessToken(readBearerToken(req) ?? "");
    const mobileReplySessionId =
      identity && authService?.getActiveAppSession(identity.sessionId)
        ? identity.sessionId
        : undefined;
    const abortBinding = bindRequestAbortController(res);
    try {
      const payload = await waitService.sendAndWait(
        req.params.id,
        parsed.data,
        {
          signal: abortBinding.signal,
          mobileReplySessionId,
        },
      );
      if (!res.headersSent && !abortBinding.signal.aborted) {
        res.status(200).json(payload);
      }
    } catch (error) {
      sendWaitRouteError(res, terminalSessionManager, req.params.id, error);
    } finally {
      abortBinding.dispose();
    }
  });

  router.post("/session/:id/wait-output", async (req, res) => {
    const parsed = waitOutputSchema.safeParse(
      req.body as TerminalWaitOutputRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        code: "INVALID_REQUEST",
        message: "Invalid request body",
        details: parsed.error.flatten(),
      });
      return;
    }

    const abortBinding = bindRequestAbortController(res);
    try {
      const payload = await waitService.waitForOutput(
        req.params.id,
        parsed.data,
        { signal: abortBinding.signal },
      );
      if (!res.headersSent && !abortBinding.signal.aborted) {
        res.status(200).json(payload);
      }
    } catch (error) {
      sendWaitRouteError(res, terminalSessionManager, req.params.id, error);
    } finally {
      abortBinding.dispose();
    }
  });
}
