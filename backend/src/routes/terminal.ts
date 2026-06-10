import { Router } from "express";
import { z } from "zod";
import type {
  CreateTerminalSessionRequest,
  CreateTerminalSessionResponse,
  CreateTerminalEventsWsTicketResponse,
  CreateTerminalWsTicketResponse,
  SendTerminalInterruptRequest,
  SendTerminalInterruptResponse,
  SendTerminalInputRequest,
  SendTerminalInputResponse,
  TerminalCompletionEventListResponse,
} from "@browser-viewer/shared";
import type { AuthService } from "../auth/service";
import { readBearerToken } from "../auth/middleware";
import { logger } from "../logging";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../terminal/manager";
import { registerTerminalPreviewRoutes } from "./terminal-preview-routes";
import { registerTerminalProjectRoutes } from "./terminal-project-routes";
import { registerTerminalClipboardImageRoutes } from "./terminal-clipboard-image-routes";
import { registerTerminalTmuxOrphanRoutes } from "./terminal-tmux-orphan-routes";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import type { TerminalCompletionEventService } from "../terminal/completion-event-service";
import {
  ensureTerminalRuntime,
  isTmuxBackedSession,
  killTmuxSessionForTerminal,
  readTerminalScrollback,
  readTerminalScrollbackCapture,
  resolveTmuxTarget,
} from "../terminal/runtime-launcher";
import type { TmuxService } from "../terminal/tmux-service";
import type { TmuxOutputWatcher } from "../terminal/tmux-output-watcher";
import {
  toHistoryPayload,
  toSessionListItem,
  toStatusPayload,
} from "./terminal-route-payloads";
import {
  buildTerminalInputOperationId,
  createTerminalSessionSchema,
  resolveTerminalCreateDefaults,
  sanitizeTerminalError,
  sendTerminalInputSchema,
  sendTerminalInterruptSchema,
  TERMINAL_INTERRUPT_ESCAPE_INPUT,
} from "./terminal-session-route-helpers";

const terminalLogger = logger.child({ component: "terminal" });

export function createTerminalRouter(
  terminalSessionManager: TerminalSessionManager,
  options?: {
    ptyService?: PtyService;
    runtimeRegistry?: TerminalRuntimeRegistry;
    tmuxService?: TmuxService;
    tmuxOutputWatcher?: TmuxOutputWatcher;
    authService?: AuthService;
    completionEventService?: TerminalCompletionEventService;
  },
): Router {
  const router = Router();

  const resolveAuthenticatedSessionId = (
    authorizationHeader: string | undefined,
  ) => {
    if (!options?.authService) {
      return null;
    }
    const token = readBearerToken({
      headers: { authorization: authorizationHeader },
    } as never);
    if (!token) {
      return null;
    }
    return options.authService.verifyAccessToken(token)?.sessionId ?? null;
  };

  const sendInputToSession = async (
    session: TerminalSessionRecord,
    data: string,
    operationId?: string,
  ): Promise<SendTerminalInputResponse> => {
    if (!options?.runtimeRegistry || !options.ptyService) {
      throw new Error("Terminal runtime service unavailable");
    }
    if (isTmuxBackedSession(session) && !options.tmuxService) {
      throw new Error("Terminal tmux service unavailable");
    }

    const ensured = await ensureTerminalRuntime({
      session,
      terminalSessionManager,
      runtimeRegistry: options.runtimeRegistry,
      ptyService: options.ptyService,
      tmuxService: options.tmuxService,
      tmuxOutputWatcher: options.tmuxOutputWatcher,
    });
    if (isTmuxBackedSession(session) && options.tmuxService) {
      await options.tmuxService.sendInput(
        resolveTmuxTarget(session, options.tmuxService),
        data,
      );
    } else {
      ensured.runtime.write(data);
    }

    return {
      operationId: operationId ?? buildTerminalInputOperationId(),
      terminalSessionId: session.id,
      inputAccepted: true,
      inputEnqueued: true,
      runtimeKind: isTmuxBackedSession(session) ? "tmux" : "pty",
      acceptedAt: new Date().toISOString(),
    };
  };

  registerTerminalProjectRoutes(router, terminalSessionManager, {
    runtimeRegistry: options?.runtimeRegistry,
    tmuxService: options?.tmuxService,
    tmuxOutputWatcher: options?.tmuxOutputWatcher,
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
      .map((session) => toSessionListItem(session));

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

  router.post("/completion-events/ws-ticket", (req, res) => {
    if (!options?.authService) {
      res.status(503).json({ message: "Terminal ticket service unavailable" });
      return;
    }
    const authSessionId = resolveAuthenticatedSessionId(
      req.headers.authorization,
    );
    if (!authSessionId) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const issued = options.authService.issueTemporaryToken({
      sessionId: authSessionId,
      tokenType: "terminal-events-ws",
      resource: {},
      ttlMs: 60_000,
    });
    const payload: CreateTerminalEventsWsTicketResponse = {
      ticket: issued.token,
      expiresIn: issued.expiresIn,
      baselineEventId: options.completionEventService?.getLatestId() ?? null,
    };
    res.status(200).json(payload);
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
      const session = await terminalSessionManager.createSession(
        resolveTerminalCreateDefaults(parsed.data, terminalSessionManager),
      );
      if (options?.ptyService && options.runtimeRegistry) {
        try {
          let launchSession = session;
          const runtimePreference = parsed.data.runtimePreference ?? "auto";
          const shouldTryTmux =
            runtimePreference === "auto" || runtimePreference === "tmux";
          let attemptedTmuxTarget: ReturnType<
            TmuxService["buildTarget"]
          > | null = null;
          const tmuxAvailable =
            options.tmuxService && shouldTryTmux
              ? await options.tmuxService.isAvailable()
              : false;
          const tmuxUnavailableReason =
            options.tmuxService && shouldTryTmux && !tmuxAvailable
              ? await options.tmuxService.getUnavailableReason()
              : null;

          if (options.tmuxService && shouldTryTmux && tmuxAvailable) {
            const target = options.tmuxService.buildTarget(session.id);
            attemptedTmuxTarget = target;
            launchSession =
              (await terminalSessionManager.updateRuntimeMetadata(session.id, {
                runtimeKind: "tmux",
                tmuxSessionName: target.sessionName,
                tmuxSocketPath: target.socketPath,
                recoverable: true,
              })) ?? session;
          } else if (options.tmuxService && shouldTryTmux) {
            terminalLogger.warn("terminal.session.runtime.tmux-unavailable", {
              message: "Terminal tmux unavailable; using pty runtime",
              terminalSessionId: session.id,
              reason: tmuxUnavailableReason ?? "tmux unavailable",
            });
            launchSession =
              (await terminalSessionManager.updateRuntimeMetadata(session.id, {
                runtimeKind: "pty",
                tmuxUnavailableReason:
                  tmuxUnavailableReason ?? "tmux unavailable",
                recoverable: false,
              })) ?? session;
          }

          try {
            await ensureTerminalRuntime({
              session: launchSession,
              terminalSessionManager,
              runtimeRegistry: options.runtimeRegistry,
              ptyService: options.ptyService,
              tmuxService: options.tmuxService,
              tmuxOutputWatcher: options.tmuxOutputWatcher,
              allowMissingTmuxSession: true,
            });
          } catch (error) {
            if (
              runtimePreference !== "auto" ||
              !options.tmuxService ||
              !isTmuxBackedSession(launchSession)
            ) {
              throw error;
            }

            const sanitizedError = sanitizeTerminalError(error);
            terminalLogger.warn(
              "terminal.session.runtime.tmux-launch-fallback",
              {
                message: "Tmux launch failed; falling back to pty",
                terminalSessionId: session.id,
                tmuxSessionName: attemptedTmuxTarget?.sessionName,
                tmuxSocketPath: attemptedTmuxTarget?.socketPath,
                error: sanitizedError,
              },
            );
            if (attemptedTmuxTarget) {
              await options.tmuxService.killSession(attemptedTmuxTarget);
            }

            launchSession =
              (await terminalSessionManager.updateRuntimeMetadata(session.id, {
                runtimeKind: "pty",
                tmuxUnavailableReason: "tmux launch failed; fell back to pty",
                recoverable: false,
              })) ?? session;
            await ensureTerminalRuntime({
              session: launchSession,
              terminalSessionManager,
              runtimeRegistry: options.runtimeRegistry,
              ptyService: options.ptyService,
              tmuxService: options.tmuxService,
              tmuxOutputWatcher: options.tmuxOutputWatcher,
              allowMissingTmuxSession: true,
            });
          }
        } catch (error) {
          await terminalSessionManager.destroySession(session.id);
          throw error;
        }
      }
      const payload: CreateTerminalSessionResponse = {
        terminalSessionId: session.id,
        terminalUrl: `/terminal/${session.id}`,
      };
      res.status(201).json(payload);
    } catch (error) {
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

    const historyScrollback = await readTerminalScrollbackCapture(
      session,
      terminalSessionManager,
      options?.tmuxService,
      "history",
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

  router.post("/session/:id/ws-ticket", (req, res) => {
    const session = terminalSessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }
    if (!options?.authService) {
      res.status(503).json({ message: "Terminal ticket service unavailable" });
      return;
    }
    const authSessionId = resolveAuthenticatedSessionId(
      req.headers.authorization,
    );
    if (!authSessionId) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const issued = options.authService.issueTemporaryToken({
      sessionId: authSessionId,
      tokenType: "terminal-ws",
      resource: { terminalSessionId: session.id },
      ttlMs: 60_000,
    });
    const payload: CreateTerminalWsTicketResponse = {
      ticket: issued.token,
      expiresIn: issued.expiresIn,
    };
    res.status(200).json(payload);
  });

  router.post("/session/:id/input", async (req, res) => {
    const parsed = sendTerminalInputSchema.safeParse(
      req.body as SendTerminalInputRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    const session = terminalSessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }
    if (session.status !== "running") {
      res.status(409).json({ message: "Terminal session is not running" });
      return;
    }
    if (!options?.runtimeRegistry || !options.ptyService) {
      res.status(503).json({ message: "Terminal runtime service unavailable" });
      return;
    }
    if (isTmuxBackedSession(session) && !options.tmuxService) {
      res.status(503).json({ message: "Terminal tmux service unavailable" });
      return;
    }

    try {
      const payload = await sendInputToSession(
        session,
        parsed.data.data,
        parsed.data.operationId,
      );
      res.status(200).json(payload);
    } catch (error) {
      terminalLogger.error("terminal.input.failed", {
        message: "Terminal input failed",
        terminalSessionId: session.id,
        inputLength: parsed.data.data.length,
        hasNewline: parsed.data.data.includes("\n"),
        operationId: parsed.data.operationId,
        error,
      });
      res.status(500).json({
        message: "Terminal input failed",
        error: String(error),
      });
    }
  });

  router.post("/session/:id/interrupt", async (req, res) => {
    const parsed = sendTerminalInterruptSchema.safeParse(
      req.body as SendTerminalInterruptRequest | undefined,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    const session = terminalSessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }
    if (session.status !== "running") {
      res.status(409).json({ message: "Terminal session is not running" });
      return;
    }
    if (!options?.runtimeRegistry || !options.ptyService) {
      res.status(503).json({ message: "Terminal runtime service unavailable" });
      return;
    }
    if (isTmuxBackedSession(session) && !options.tmuxService) {
      res.status(503).json({ message: "Terminal tmux service unavailable" });
      return;
    }

    try {
      const inputPayload = await sendInputToSession(
        session,
        TERMINAL_INTERRUPT_ESCAPE_INPUT,
        parsed.data.operationId,
      );
      const payload: SendTerminalInterruptResponse = {
        ...inputPayload,
        interruptAccepted: true,
        interruptSequence: "escape",
      };
      res.status(200).json(payload);
    } catch (error) {
      terminalLogger.error("terminal.interrupt.failed", {
        message: "Terminal interrupt failed",
        terminalSessionId: session.id,
        operationId: parsed.data.operationId,
        error,
      });
      res.status(500).json({
        message: "Terminal interrupt failed",
        error: error instanceof Error ? error.message : String(error),
        operationId: parsed.data.operationId,
      });
    }
  });

  registerTerminalClipboardImageRoutes(router, terminalSessionManager);

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

    res.status(204).send();
  });

  return router;
}
