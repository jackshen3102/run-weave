import { Router } from "express";
import { z } from "zod";
import type { AgentHookStateRequest, TerminalStateResponse } from "@runweave/shared/terminal/events";
import { logger } from "../logging";
import type { TerminalSessionManager } from "../terminal/manager";
import {
  aggregatePanelTerminalState,
  type TerminalStateService,
} from "../terminal/terminal-state-service";
import type { TmuxService } from "../terminal/tmux-service";
import type { TerminalActivityDependencies } from "../terminal/activity-events";
import type { ActivityEventInput } from "@runweave/shared/activity";
import crypto from "node:crypto";
import { processTerminalAgentHook } from "../terminal/agent-hook-processor";

const terminalStateLogger = logger.child({ component: "terminal-state" });
const AGENT_HOOKS = ["codex", "trae", "traecli", "traex"] as const;

const agentHookStateSchema = z
  .object({
    activityEventId: z.string().uuid().optional(),
    operationId: z.string().trim().min(1).max(256).optional(),
    terminalSessionId: z.string().trim().min(1),
    projectId: z.string().trim().min(1).optional(),
    threadId: z.string().trim().min(1).optional(),
    panelId: z.string().trim().min(1).nullable().optional(),
    tmuxPaneId: z.string().trim().min(1).nullable().optional(),
    commandName: z.string().trim().min(1).nullable().optional(),
    rawHookEvent: z.string().trim().min(1).max(128).optional(),
    sessionSource: z.enum(["startup", "resume"]).optional(),
    query: z.string().max(8_000).optional(),
    response: z.string().max(8_000).optional(),
    agent: z.enum(AGENT_HOOKS),
    hookEvent: z.enum([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "ToolRequested",
      "ToolCompleted",
    ]),
    toolUseId: z.string().trim().min(1).max(256).optional(),
    toolName: z.string().trim().min(1).max(256).optional(),
    toolInput: z.unknown().optional(),
    toolResult: z.unknown().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.hookEvent === "ToolRequested" ||
        value.hookEvent === "ToolCompleted") &&
      (!value.toolUseId || !value.toolName)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Tool hooks require toolUseId and toolName",
        path: ["toolUseId"],
      });
    }
  });

export function createTerminalStateRouter(options: {
  terminalSessionManager: TerminalSessionManager;
  terminalStateService: TerminalStateService;
  tmuxService?: TmuxService;
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

    const runningPanels = options.terminalSessionManager
      .listPanels(session.id)
      .filter((panel) => panel.status === "running");
    const terminalState =
      runningPanels.length > 0
        ? aggregatePanelTerminalState(runningPanels)
        : options.terminalStateService.getCurrent(session.id, session);

    const payload: TerminalStateResponse = { terminalState };
    res.json(payload);
  });

  return router;
}

export function createInternalTerminalAgentHookRouter(options: {
  terminalSessionManager: TerminalSessionManager;
  terminalStateService: TerminalStateService;
  hookToken: string | undefined;
  activity?: TerminalActivityDependencies;
}): Router {
  const router = Router();
  const hookActivityEvents = new Map<string, ActivityEventInput>();

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

    if (
      parsed.data.hookEvent === "ToolRequested" ||
      parsed.data.hookEvent === "ToolCompleted"
    ) {
      const session = options.terminalSessionManager.getSession(
        parsed.data.terminalSessionId,
      );
      if (!session) {
        res.status(404).json({ message: "Terminal session not found" });
        return;
      }
      recordAgentHookActivity(options.activity, parsed.data, hookActivityEvents);
      res.status(202).json({
        terminalState: options.terminalStateService.getCurrent(session.id, session),
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
        panelId: result.panelId,
      });
      res.status(202).json({ terminalState: result.terminalState });
      return;
    }

    terminalStateLogger.info("terminal-state.hook.recorded", {
      message: "Terminal agent hook recorded",
      terminalSessionId: result.terminalSessionId,
      agent: result.agent,
      hookEvent: result.hookEvent,
      panelId: result.panelId,
      state: result.terminalState.state,
    });
    recordAgentHookActivity(options.activity, parsed.data, hookActivityEvents);
    res.status(202).json({ terminalState: result.terminalState });
  });

  return router;
}

function recordAgentHookActivity(
  activity: TerminalActivityDependencies | undefined,
  hook: AgentHookStateRequest,
  hookActivityEvents: Map<string, ActivityEventInput>,
): void {
  if (!activity) return;
  const rawHookEvent = hook.rawHookEvent?.toLowerCase() ?? "";
  if (rawHookEvent.includes("subagent")) return;
  const eventName =
    hook.hookEvent === "ToolRequested"
      ? "agent.tool.requested"
      : hook.hookEvent === "ToolCompleted"
        ? "agent.tool.completed"
        : hook.hookEvent === "SessionStart"
      ? hook.sessionSource === "resume"
        ? "agent.thread.resumed"
        : "agent.thread.started"
      : hook.hookEvent === "UserPromptSubmit"
        ? "user.query.submit_requested"
        : "agent.response.observed";
  const content =
    hook.hookEvent === "ToolRequested"
      ? hook.toolInput
      : hook.hookEvent === "ToolCompleted"
        ? hook.toolResult
        : hook.hookEvent === "UserPromptSubmit"
      ? hook.query
      : hook.hookEvent === "Stop"
        ? hook.response
        : undefined;
  const existingEvent = hook.activityEventId
    ? hookActivityEvents.get(hook.activityEventId)
    : undefined;
  if (existingEvent) {
    activity.recorder.record(existingEvent);
    return;
  }
  const event = activity.eventFactory.create({
    eventName,
    actorType: hook.hookEvent === "UserPromptSubmit" ? "user" : "agent",
    actorAgent:
      hook.agent === "codex"
        ? "codex"
        : hook.agent.startsWith("trae")
          ? "trae"
          : "other",
    scope: {
      projectId: hook.projectId,
      terminalSessionId: hook.terminalSessionId,
      panelId: hook.panelId ?? undefined,
      tmuxPaneId: hook.tmuxPaneId ?? undefined,
      threadId: hook.threadId,
      operationId: hook.toolUseId,
    },
    payload: {
      agent: hook.agent,
      source: hook.sessionSource ?? "unknown",
      ...(hook.toolUseId ? { toolUseId: hook.toolUseId } : {}),
      ...(hook.toolName ? { toolName: hook.toolName } : {}),
    },
  });
  if (hook.activityEventId) {
    event.eventId = hook.activityEventId;
  }
  if (content !== undefined && content !== null) {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    event.contents.push({
      contentId: crypto.randomUUID(),
      role:
        hook.hookEvent === "ToolRequested"
          ? "tool_args"
          : hook.hookEvent === "ToolCompleted"
            ? "tool_result"
            : hook.hookEvent === "UserPromptSubmit"
              ? "query"
              : "response",
      mediaType:
        typeof content === "string"
          ? "text/plain; charset=utf-8"
          : "application/json",
      bytesBase64: Buffer.from(text, "utf8").toString("base64"),
    });
  }
  if (hook.activityEventId) {
    hookActivityEvents.set(hook.activityEventId, event);
    if (hookActivityEvents.size > 10_000) {
      const oldestEventId = hookActivityEvents.keys().next().value;
      if (oldestEventId) hookActivityEvents.delete(oldestEventId);
    }
  }
  activity.recorder.record(event);
}
