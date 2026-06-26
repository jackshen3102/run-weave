import { Router } from "express";
import { z } from "zod";
import type {
  AgentHookStateRequest,
  TerminalStateResponse,
} from "@runweave/shared";
import { logger } from "../logging";
import type { TerminalSessionManager } from "../terminal/manager";
import type { TerminalStateService } from "../terminal/terminal-state-service";
import { processTerminalAgentHook } from "../terminal/agent-hook-processor";

const terminalStateLogger = logger.child({ component: "terminal-state" });
const AGENT_HOOKS = ["codex", "trae", "traecli", "traex"] as const;

const agentHookStateSchema = z
  .object({
    terminalSessionId: z.string().trim().min(1),
    projectId: z.string().trim().min(1).optional(),
    threadId: z.string().trim().min(1).optional(),
    agent: z.enum(AGENT_HOOKS),
    hookEvent: z.enum(["SessionStart", "UserPromptSubmit", "Stop"]),
  })
  .strict();

export function createTerminalStateRouter(options: {
  terminalSessionManager: TerminalSessionManager;
  terminalStateService: TerminalStateService;
}): Router {
  const router = Router();

  router.get("/session/:terminalSessionId/state", async (req, res) => {
    const session = options.terminalSessionManager.getSession(
      req.params.terminalSessionId,
    );
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }

    const terminalState = options.terminalStateService.getCurrent(
      session.id,
      session,
    );

    const payload: TerminalStateResponse = { terminalState };
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

  router.post("/", async (req, res) => {
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

    const result = await processTerminalAgentHook(options, parsed.data);
    if (result.status === "not_found") {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }
    if (result.status === "exited") {
      res.status(202).json({ terminalState: result.terminalState });
      return;
    }
    if (result.status === "ignored") {
      terminalStateLogger.info("terminal-state.hook.ignored", {
        message: "Terminal agent hook ignored because agent is not current",
        terminalSessionId: result.terminalSessionId,
        agent: result.agent,
        hookEvent: result.hookEvent,
        activeCommand: result.activeCommand,
      });
      res.status(202).json({ terminalState: result.terminalState });
      return;
    }

    terminalStateLogger.info("terminal-state.hook.recorded", {
      message: "Terminal agent hook recorded",
      terminalSessionId: result.terminalSessionId,
      agent: result.agent,
      hookEvent: result.hookEvent,
      state: result.terminalState.state,
    });
    res.status(202).json({ terminalState: result.terminalState });
  });

  return router;
}
