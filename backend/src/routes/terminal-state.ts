import { Router } from "express";
import { z } from "zod";
import type {
  AgentHookStateRequest,
  TerminalStateResponse,
} from "@browser-viewer/shared";
import { logger } from "../logging";
import {
  isCompletionSourceAllowedForCommand,
  AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS,
} from "../terminal/completion-source-gate";
import type { TerminalSessionManager } from "../terminal/manager";
import {
  isCodexSession,
  type TerminalStateService,
} from "../terminal/terminal-state-service";

const terminalStateLogger = logger.child({ component: "terminal-state" });

const agentHookStateSchema = z
  .object({
    terminalSessionId: z.string().trim().min(1),
    projectId: z.string().trim().min(1).optional(),
    agent: z.literal("codex"),
    hookEvent: z.enum(["SessionStart", "UserPromptSubmit", "Stop"]),
  })
  .strict();

export function createTerminalStateRouter(options: {
  terminalSessionManager: TerminalSessionManager;
  terminalStateService: TerminalStateService;
}): Router {
  const router = Router();

  router.get("/session/:terminalSessionId/state", (req, res) => {
    const session = options.terminalSessionManager.getSession(
      req.params.terminalSessionId,
    );
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }

    const payload: TerminalStateResponse = {
      terminalState: options.terminalStateService.getCurrent(
        session.id,
        session,
      ),
    };
    res.json(payload);
  });

  return router;
}

export function createInternalTerminalAgentHookRouter(options: {
  terminalSessionManager: TerminalSessionManager;
  terminalStateService: TerminalStateService;
  hookToken: string | undefined;
}): Router {
  const router = Router();

  router.post("/", (req, res) => {
    const expectedToken = options.hookToken?.trim();
    const providedToken = String(req.headers["x-runweave-hook-token"] ?? "");
    if (!expectedToken || providedToken !== expectedToken) {
      terminalStateLogger.warn("terminal-state.hook.unauthorized", {
        message: "Terminal agent hook rejected",
      });
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const parsed = agentHookStateSchema.safeParse(
      req.body as AgentHookStateRequest,
    );
    if (!parsed.success) {
      terminalStateLogger.warn("terminal-state.hook.invalid", {
        message: "Invalid terminal agent hook body",
        errors: parsed.error.flatten(),
      });
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    const session = options.terminalSessionManager.getSession(
      parsed.data.terminalSessionId,
    );
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }
    if (session.status === "exited") {
      res.status(202).json({
        terminalState: options.terminalStateService.getCurrent(
          session.id,
          session,
        ),
      });
      return;
    }

    const lastAiActiveCommand =
      options.terminalSessionManager.getLastAiActiveCommand(session.id);
    const currentCommandMatches = isCompletionSourceAllowedForCommand(
      "codex",
      session.activeCommand,
    ) || isCodexSession(session);
    const graceCommandMatches =
      session.activeCommand === null &&
      lastAiActiveCommand !== null &&
      lastAiActiveCommand.source === "codex" &&
      lastAiActiveCommand.clearedAt !== null &&
      Date.now() - lastAiActiveCommand.clearedAt <=
        AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS;

    if (
      parsed.data.hookEvent !== "SessionStart" &&
      !currentCommandMatches &&
      !graceCommandMatches &&
      options.terminalStateService.getCurrent(session.id, session).agent !==
        "codex"
    ) {
      terminalStateLogger.info("terminal-state.hook.ignored", {
        message: "Terminal agent hook ignored because codex is not current",
        terminalSessionId: session.id,
        hookEvent: parsed.data.hookEvent,
        activeCommand: session.activeCommand,
      });
      res.status(202).json({
        terminalState: options.terminalStateService.getCurrent(
          session.id,
          session,
        ),
      });
      return;
    }

    const terminalState = options.terminalStateService.handleAgentHook(
      session.id,
      parsed.data.agent,
      parsed.data.hookEvent,
    );
    terminalStateLogger.info("terminal-state.hook.recorded", {
      message: "Terminal agent hook recorded",
      terminalSessionId: session.id,
      agent: parsed.data.agent,
      hookEvent: parsed.data.hookEvent,
      state: terminalState.state,
    });
    res.status(202).json({ terminalState });
  });

  return router;
}
