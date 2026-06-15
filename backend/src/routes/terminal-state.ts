import { Router } from "express";
import { z } from "zod";
import type {
  AgentHookStateRequest,
  TerminalStateResponse,
} from "@runweave/shared";
import { logger } from "../logging";
import {
  isCompletionSourceAllowedForCommand,
  AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS,
} from "../terminal/completion-source-gate";
import type { TerminalSessionManager } from "../terminal/manager";
import {
  getTerminalSessionAgent,
  type TerminalStateService,
} from "../terminal/terminal-state-service";

const terminalStateLogger = logger.child({ component: "terminal-state" });
const AGENT_ACTIVE_COMMANDS = {
  codex: "codex",
  trae: "trae",
  traecli: "traecli",
  traex: "traex",
} as const;
const AGENT_HOOKS = ["codex", "trae", "traecli", "traex"] as const;

const agentHookStateSchema = z
  .object({
    terminalSessionId: z.string().trim().min(1),
    projectId: z.string().trim().min(1).optional(),
    agent: z.enum(AGENT_HOOKS),
    hookEvent: z.enum(["SessionStart", "UserPromptSubmit", "Stop"]),
  })
  .strict();

function commandBasename(command: string | null): string | null {
  const normalized = command?.trim().replace(/\\+/g, "/");
  if (!normalized) {
    return null;
  }
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}

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

    let session = options.terminalSessionManager.getSession(
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

    if (commandBasename(session.activeCommand) === "node") {
      session =
        (await options.terminalSessionManager.updateSessionMetadata(
          session.id,
          {
            cwd: session.cwd,
            activeCommand: AGENT_ACTIVE_COMMANDS[parsed.data.agent],
          },
        )) ?? session;
    }

    const sessionAgent = getTerminalSessionAgent(session);
    const effectiveAgent =
      sessionAgent &&
      isCompletionSourceAllowedForCommand(parsed.data.agent, session.activeCommand)
        ? sessionAgent
        : parsed.data.agent;
    const lastAiActiveCommand =
      options.terminalSessionManager.getLastAiActiveCommand(session.id);
    const currentCommandMatches = isCompletionSourceAllowedForCommand(
      parsed.data.agent,
      session.activeCommand,
    ) || sessionAgent === effectiveAgent;
    const graceCommandMatches =
      session.activeCommand === null &&
      lastAiActiveCommand !== null &&
      lastAiActiveCommand.source === parsed.data.agent &&
      lastAiActiveCommand.clearedAt !== null &&
      Date.now() - lastAiActiveCommand.clearedAt <=
        AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS;

    if (
      parsed.data.hookEvent !== "SessionStart" &&
      !currentCommandMatches &&
      !graceCommandMatches &&
      options.terminalStateService.getCurrent(session.id, session).agent !==
        effectiveAgent
    ) {
      terminalStateLogger.info("terminal-state.hook.ignored", {
        message: "Terminal agent hook ignored because agent is not current",
        terminalSessionId: session.id,
        agent: effectiveAgent,
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
      effectiveAgent,
      parsed.data.hookEvent,
      {
        projectId: session.projectId,
        reason: "agent_hook",
      },
    );
    terminalStateLogger.info("terminal-state.hook.recorded", {
      message: "Terminal agent hook recorded",
      terminalSessionId: session.id,
      agent: effectiveAgent,
      hookEvent: parsed.data.hookEvent,
      state: terminalState.state,
    });
    res.status(202).json({ terminalState });
  });

  return router;
}
