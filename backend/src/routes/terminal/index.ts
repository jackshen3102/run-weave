import { registerTerminalSessionUpdateRoute } from "./sessions/update";
import { Router } from "express";
import { registerBrowserAssistanceRoutes } from "./browser-assistance";
import { z } from "zod";
import type { TerminalCompletionEventListResponse } from "@runweave/shared/terminal/events";
import type {
  CreateTerminalSessionRequest,
  CreateTerminalSessionResponse,
} from "@runweave/shared/terminal/session";
import type { AuthService } from "../../auth/service";
import {
  recordTerminalSessionDeleted,
  type TerminalActivityDependencies,
} from "../../terminal/runtime/activity-events";
import { logger } from "../../logging/index";
import type { TerminalSessionManager } from "../../terminal/manager/manager";
import { registerTerminalPreviewRoutes } from "./preview/index";
import { registerTerminalProjectRoutes } from "./projects/index";
import { registerTerminalProjectContextRoutes } from "./projects/context";
import type { TerminalWorktreeDeletionOwnerHooks } from "../../terminal/workspace-service/worktree-deletion";
import { registerTerminalTmuxOrphanRoutes } from "./sessions/tmux-orphan";
import type { PtyService } from "../../terminal/runtime/pty-service";
import type { TerminalRuntimeRegistry } from "../../terminal/runtime/registry";
import type { TerminalCompletionEventService } from "../../terminal/completion/event-service";
import type { TerminalEventService } from "../../terminal/state/terminal-event-service";
import type { TerminalStateService } from "../../terminal/state/terminal-state-service";
import {
  isTmuxBackedSession,
  killTmuxSessionForTerminal,
  readTerminalScrollback,
  readTerminalScrollbackCapture,
} from "../../terminal/runtime/launcher";
import type { TmuxService } from "../../terminal/tmux/service";
import type { TmuxOutputWatcher } from "../../terminal/tmux/output-watcher";
import type { TerminalQuickInputService } from "../../terminal/quick-input/service";
import {
  toHistoryPayload,
  toPanelWorkspacePayload,
  toSessionListItem,
  toStatusPayload,
} from "../../terminal/application/payloads";
import { resolveEffectiveTerminalState } from "../../terminal/application/terminal-state-projection";
import {
  createTerminalSessionSchema,
  sanitizeTerminalError,
  TerminalCreateDefaultsError,
} from "./sessions/helpers";
import { registerTerminalTicketRoutes } from "./input/ticket";
import { registerTerminalPrototypeGalleryRoutes } from "./preview/gallery";
import { registerTerminalHtmlPreviewRoutes } from "./preview/html";
import { registerTerminalQuickInputRoutes } from "./input/quick";
import { registerTerminalInputRoutes } from "./input/index";
import {
  registerTerminalPanelRoutes,
  resolvePanelTarget,
} from "./panels/index";
import type { WorkspaceServiceManager } from "../../terminal/workspace-service/manager";
import { createTerminalSession } from "../../terminal/application/create-session";
import {
  getTerminalAgentSettings,
  updateTerminalAgentSettings,
  TerminalAgentSettingsError,
} from "../../terminal/runtime/terminal-agent-settings";
import { sendTerminalPanelRouteError } from "./panels/common";

const terminalLogger = logger.child({ component: "terminal" });

async function readTerminalHistory(
  session: NonNullable<ReturnType<TerminalSessionManager["getSession"]>>,
  terminalSessionManager: TerminalSessionManager,
  tmuxService: TmuxService | undefined,
  terminalEventService: TerminalEventService | undefined,
) {
  if (!tmuxService || !isTmuxBackedSession(session)) {
    return readTerminalScrollbackCapture(
      session,
      terminalSessionManager,
      tmuxService,
      "history",
    );
  }

  const target = tmuxService.buildTarget(session.id);
  try {
    if (!(await tmuxService.hasSession(target))) {
      return { data: await terminalSessionManager.readScrollback(session.id) };
    }
    const { paneTarget } = await resolvePanelTarget(
      terminalSessionManager,
      session,
      { tmuxService, terminalEventService },
      {},
      "default-history",
    );
    const capture = await tmuxService.capturePane(paneTarget);
    return { data: capture.data, sourceCols: capture.sourceCols };
  } catch (error) {
    terminalLogger.warn("terminal.session.history.tmux-fallback", {
      message: "Terminal history fell back to persisted scrollback",
      terminalSessionId: session.id,
      error,
    });
    return { data: await terminalSessionManager.readScrollback(session.id) };
  }
}

export function createTerminalRouter(
  terminalSessionManager: TerminalSessionManager,
  options?: {
    ptyService?: PtyService;
    runtimeRegistry?: TerminalRuntimeRegistry;
    tmuxService?: TmuxService;
    tmuxOutputWatcher?: TmuxOutputWatcher;
    authService?: AuthService;
    completionEventService?: TerminalCompletionEventService;
    terminalEventService?: TerminalEventService;
    terminalStateService?: TerminalStateService;
    quickInputService?: TerminalQuickInputService;
    activity?: TerminalActivityDependencies;
    worktreeDeletionOwnerHooks?: TerminalWorktreeDeletionOwnerHooks;
    workspaceServiceManager?: WorkspaceServiceManager;
  },
): Router {
  const router = Router();

  const agentSettingsUpdateSchema = z.object({
    panelId: z.string().min(1).nullable(),
    threadId: z.string().min(1),
    expectedRevision: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1),
  }).strict();
  const sendAgentSettingsError = (res: Parameters<typeof sendTerminalPanelRouteError>[0], error: unknown) => {
    if (error instanceof TerminalAgentSettingsError) {
      res.status(error.status).json({ code: error.code, message: error.message });
    } else if (!sendTerminalPanelRouteError(res, error)) {
      terminalLogger.warn("terminal.agent-settings.failed", { error });
      res.status(503).json({ code: "agent_settings_unavailable", message: "Agent 设置暂不可用" });
    }
  };
  router.get("/session/:id/agent-settings", async (req, res) => {
    try {
      const session = terminalSessionManager.getSession(req.params.id);
      if (!session) { res.status(404).json({ code: "agent_settings_unavailable", message: "终端不存在" }); return; }
      if (!options?.tmuxService) { res.status(503).json({ code: "agent_settings_unavailable", message: "终端服务不可用" }); return; }
      const panelId = typeof req.query.panelId === "string" ? req.query.panelId : undefined;
      res.json(await getTerminalAgentSettings(terminalSessionManager, options.tmuxService, session, panelId));
    } catch (error) { sendAgentSettingsError(res, error); }
  });
  router.put("/session/:id/agent-settings", async (req, res) => {
    const parsed = agentSettingsUpdateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ code: "invalid_request", message: "模型设置参数无效" }); return; }
    try {
      const session = terminalSessionManager.getSession(req.params.id);
      if (!session) { res.status(404).json({ code: "agent_settings_unavailable", message: "终端不存在" }); return; }
      if (!options?.tmuxService) { res.status(503).json({ code: "agent_settings_unavailable", message: "终端服务不可用" }); return; }
      res.json(await updateTerminalAgentSettings(terminalSessionManager, options.tmuxService, session, parsed.data));
    } catch (error) { sendAgentSettingsError(res, error); }
  });

  registerTerminalProjectRoutes(router, terminalSessionManager, {
    runtimeRegistry: options?.runtimeRegistry,
    tmuxService: options?.tmuxService,
    tmuxOutputWatcher: options?.tmuxOutputWatcher,
    terminalEventService: options?.terminalEventService,
    workspaceServiceManager: options?.workspaceServiceManager,
  });
  registerTerminalProjectContextRoutes(router, terminalSessionManager, {
    runtimeRegistry: options?.runtimeRegistry,
    terminalStateService: options?.terminalStateService,
    terminalEventService: options?.terminalEventService,
    tmuxService: options?.tmuxService,
    tmuxOutputWatcher: options?.tmuxOutputWatcher,
    activity: options?.activity,
    ownerHooks: options?.worktreeDeletionOwnerHooks,
  });
  registerTerminalPreviewRoutes(router, terminalSessionManager);

  const reorderSessionsSchema = z
    .object({
      projectId: z.string().trim().min(1),
      orderedIds: z.array(z.string().min(1)).min(1),
    })
    .strict();

  router.put("/session/reorder", async (req, res) => {
    const parsed = reorderSessionsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    try {
      await terminalSessionManager.reorderSessions(
        parsed.data.projectId,
        parsed.data.orderedIds,
      );
      res.status(204).send();
    } catch (error) {
      terminalLogger.error("terminal.session.reorder.failed", {
        message: "Terminal session reorder failed",
        error,
      });
      res.status(500).json({
        message: "Terminal session reorder failed",
        error: String(error),
      });
    }
  });

  router.get("/session", (_req, res) => {
    const payload = terminalSessionManager
      .listSessions()
      .map((session) =>
        toSessionListItem(
          session,
          resolveEffectiveTerminalState(
            terminalSessionManager,
            options?.terminalStateService,
            session,
          ),
          toPanelWorkspacePayload(terminalSessionManager, session.id),
        ),
      );

    res.json(payload);
  });

  router.get("/completion-events", (req, res) => {
    const after =
      typeof req.query.after === "string" && req.query.after.trim()
        ? req.query.after.trim()
        : null;
    const payload: TerminalCompletionEventListResponse = {
      events: options?.completionEventService?.listAfter(after) ?? [],
    };
    res.json(payload);
  });

  registerTerminalTicketRoutes(router, terminalSessionManager, {
    authService: options?.authService,
    terminalEventService: options?.terminalEventService,
  });
  registerTerminalPrototypeGalleryRoutes(
    router,
    terminalSessionManager,
    options?.authService,
  );
  registerTerminalHtmlPreviewRoutes(router, terminalSessionManager, options?.authService);
  if (options?.quickInputService) {
    registerTerminalQuickInputRoutes(router, options.quickInputService);
  }
  registerTerminalPanelRoutes(router, terminalSessionManager, {
    ptyService: options?.ptyService,
    runtimeRegistry: options?.runtimeRegistry,
    tmuxService: options?.tmuxService,
    tmuxOutputWatcher: options?.tmuxOutputWatcher,
    terminalEventService: options?.terminalEventService,
    terminalStateService: options?.terminalStateService,
  });

  router.post("/session", async (req, res) => {
    const parsed = createTerminalSessionSchema.safeParse(
      req.body as CreateTerminalSessionRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    try {
      terminalLogger.info("terminal.session.create.requested", {
        message: "Terminal session create requested",
        projectId: parsed.data.projectId,
        runtimePreference: parsed.data.runtimePreference ?? "auto",
        cwdProvided: Boolean(parsed.data.cwd),
        commandProvided: Boolean(parsed.data.command),
      });
      const session = await createTerminalSession(
        terminalSessionManager,
        parsed.data,
        {
          ptyService: options?.ptyService,
          runtimeRegistry: options?.runtimeRegistry,
          tmuxService: options?.tmuxService,
          tmuxOutputWatcher: options?.tmuxOutputWatcher,
          terminalEventService: options?.terminalEventService,
          terminalStateService: options?.terminalStateService,
          activity: options?.activity,
        },
      );
      const payload: CreateTerminalSessionResponse = {
        terminalSessionId: session.id,
        terminalUrl: `/terminal/${session.id}`,
      };
      res.status(201).json(payload);
    } catch (error) {
      if (error instanceof TerminalCreateDefaultsError) {
        res.status(error.statusCode).json({ message: error.message });
        return;
      }
      const sanitizedError = sanitizeTerminalError(error);
      terminalLogger.error("terminal.session.create.failed", {
        message: "Create terminal session failed",
        error: sanitizedError,
      });
      res.status(500).json({
        message: "Failed to create terminal session",
        error: sanitizedError,
      });
    }
  });

  registerTerminalTmuxOrphanRoutes(
    router,
    terminalSessionManager,
    options?.tmuxService,
  );

  router.get("/session/:id/history", async (req, res) => {
    const session = terminalSessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }

    const historyScrollback = await readTerminalHistory(
      session,
      terminalSessionManager,
      options?.tmuxService,
      options?.terminalEventService,
    );

    res.json(
      toHistoryPayload(
        session,
        historyScrollback.data,
        historyScrollback.sourceCols,
      ),
    );
  });

  router.get("/session/:id", async (req, res) => {
    const session = terminalSessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }

    res.json(
      toStatusPayload(
        session,
        await readTerminalScrollback(
          session,
          terminalSessionManager,
          options?.tmuxService,
          "live",
        ),
      ),
    );
  });

  registerTerminalSessionUpdateRoute(router, terminalSessionManager, options?.terminalStateService);
  registerTerminalInputRoutes(router, terminalSessionManager, options);
  registerBrowserAssistanceRoutes(router, terminalSessionManager, options);
  router.delete("/session/:id", async (req, res) => {
    const session = terminalSessionManager.getSession(req.params.id);
    terminalLogger.info("terminal.session.delete.started", {
      message: "Terminal session delete started",
      terminalSessionId: req.params.id,
      existed: Boolean(session),
    });
    try {
      if (options?.runtimeRegistry) {
        await options.runtimeRegistry.disposeRuntime(req.params.id);
      }
      await options?.tmuxOutputWatcher?.unwatchSession(req.params.id);
      if (session) {
        await killTmuxSessionForTerminal(session, options?.tmuxService);
      }
      const deleted = await terminalSessionManager.destroySession(
        req.params.id,
      );
      if (!deleted) {
        res.status(404).json({ message: "Terminal session not found" });
        return;
      }
    } catch (error) {
      terminalLogger.error("terminal.session.delete.failed", {
        message: "Terminal session delete failed",
        terminalSessionId: req.params.id,
        error,
      });
      res.status(500).json({
        message: "Failed to delete terminal session",
        error: String(error),
      });
      return;
    }

    options?.terminalEventService?.record({
      kind: "terminal_session_deleted",
      terminalSessionId: req.params.id,
      projectId: session?.projectId ?? null,
      payload: {
        terminalSessionId: req.params.id,
        projectId: session?.projectId ?? null,
      },
    });
    recordTerminalSessionDeleted(options?.activity, session);
    res.status(204).send();
  });

  return router;
}
