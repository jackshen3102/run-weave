import { Router } from "express";
import { z } from "zod";
import type {
  CreateTerminalSessionRequest,
  CreateTerminalSessionResponse,
  SendTerminalInterruptRequest,
  SendTerminalInterruptResponse,
  SendTerminalInputRequest,
  TerminalState,
  TerminalInputMode,
  TerminalCompletionEventListResponse,
  UpdateTerminalSessionRequest,
} from "@runweave/shared";
import type { AuthService } from "../auth/service";
import { logger } from "../logging";
import { aiDiagnosticLog } from "../diagnostic-logs/recorder";
import type { TerminalSessionManager } from "../terminal/manager";
import { registerTerminalPreviewRoutes } from "./terminal-preview-routes";
import { registerTerminalProjectRoutes } from "./terminal-project-routes";
import { registerTerminalClipboardImageRoutes } from "./terminal-clipboard-image-routes";
import { registerTerminalTmuxOrphanRoutes } from "./terminal-tmux-orphan-routes";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import type { TerminalCompletionEventService } from "../terminal/completion-event-service";
import type { TerminalEventService } from "../terminal/terminal-event-service";
import {
  aggregatePanelTerminalState,
  getTerminalSessionAgent,
  type TerminalStateService,
} from "../terminal/terminal-state-service";
import {
  ensureTerminalRuntime,
  isTmuxBackedSession,
  killTmuxSessionForTerminal,
  readTerminalScrollback,
  readTerminalScrollbackCapture,
} from "../terminal/runtime-launcher";
import type { TmuxService } from "../terminal/tmux-service";
import type { TmuxOutputWatcher } from "../terminal/tmux-output-watcher";
import type { TerminalQuickInputService } from "../terminal/quick-input-service";
import {
  toHistoryPayload,
  toPanelWorkspacePayload,
  toSessionListItem,
  toStatusPayload,
} from "./terminal-route-payloads";
import {
  createTerminalSessionSchema,
  resolveTerminalCreateDefaults,
  sanitizeTerminalError,
  sendTerminalInputSchema,
  sendTerminalInterruptSchema,
  TerminalCreateDefaultsError,
  TERMINAL_INTERRUPT_ESCAPE_INPUT,
} from "./terminal-session-route-helpers";
import {
  isMissingTerminalRuntimeError,
  normalizeCodexSlashCommand,
  sendInputToSession,
} from "./terminal-input-dispatcher";
import { registerTerminalTicketRoutes } from "./terminal-ticket-routes";
import { registerTerminalQuickInputRoutes } from "./terminal-quick-input-routes";
import {
  ensureTerminalPanelWorkspace,
  registerTerminalPanelRoutes,
  resolvePanelTarget,
  sendTerminalPanelRouteError,
} from "./terminal-panel-routes";

const terminalLogger = logger.child({ component: "terminal" });

function resolveTerminalStateFromPanels(
  terminalSessionManager: TerminalSessionManager,
  terminalStateService: TerminalStateService | undefined,
  session: NonNullable<ReturnType<TerminalSessionManager["getSession"]>>,
): TerminalState | undefined {
  const runningPanels = terminalSessionManager
    .listPanels(session.id)
    .filter((panel) => panel.status === "running");
  if (runningPanels.length > 0) {
    return aggregatePanelTerminalState(runningPanels);
  }
  return terminalStateService?.getCurrent(session.id, session);
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
  },
): Router {
  const router = Router();

  registerTerminalProjectRoutes(router, terminalSessionManager, {
    runtimeRegistry: options?.runtimeRegistry,
    tmuxService: options?.tmuxService,
    tmuxOutputWatcher: options?.tmuxOutputWatcher,
    terminalEventService: options?.terminalEventService,
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
          resolveTerminalStateFromPanels(
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

  const updateTerminalSessionSchema = z
    .object({
      alias: z.string().trim().max(80).nullable().optional(),
      panelSplitEnabled: z.boolean().optional(),
    })
    .strict();

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
      if (
        parsed.data.projectId &&
        !terminalSessionManager.getProject(parsed.data.projectId)
      ) {
        res.status(404).json({ message: "Terminal project not found" });
        return;
      }
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
      const createdSession =
        terminalSessionManager.getSession(session.id) ?? session;
      if (options?.tmuxService && isTmuxBackedSession(createdSession)) {
        try {
          await ensureTerminalPanelWorkspace(
            terminalSessionManager,
            createdSession,
            {
              ptyService: options.ptyService,
              runtimeRegistry: options.runtimeRegistry,
              tmuxService: options.tmuxService,
              tmuxOutputWatcher: options.tmuxOutputWatcher,
              terminalEventService: options.terminalEventService,
            },
          );
        } catch (error) {
          terminalLogger.warn("terminal.session.default-panel.failed", {
            message: "Create terminal default panel failed",
            terminalSessionId: createdSession.id,
            error,
          });
        }
      }
      options?.terminalEventService?.record({
        kind: "terminal_session_created",
        terminalSessionId: session.id,
        projectId: createdSession.projectId,
        payload: {
          session: toSessionListItem(
            createdSession,
            resolveTerminalStateFromPanels(
              terminalSessionManager,
              options.terminalStateService,
              createdSession,
            ),
            toPanelWorkspacePayload(terminalSessionManager, createdSession.id),
          ),
        },
      });
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

    const historyScrollback =
      options?.tmuxService && isTmuxBackedSession(session)
        ? await (async () => {
            const { paneTarget } = await resolvePanelTarget(
              terminalSessionManager,
              session,
              {
                tmuxService: options.tmuxService,
                terminalEventService: options.terminalEventService,
              },
              {},
              "default-history",
            );
            const capture = await options.tmuxService!.capturePane(paneTarget);
            return {
              data: capture.data,
              sourceCols: capture.sourceCols,
            };
          })()
        : await readTerminalScrollbackCapture(
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

  router.patch("/session/:id", async (req, res) => {
    const parsed = updateTerminalSessionSchema.safeParse(
      req.body as UpdateTerminalSessionRequest,
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

    try {
      let updatedSession = session;
      if (parsed.data.alias !== undefined) {
        updatedSession =
          (await terminalSessionManager.updateSessionAlias(
            session.id,
            parsed.data.alias,
          )) ?? updatedSession;
      }
      if (parsed.data.panelSplitEnabled !== undefined) {
        updatedSession =
          (await terminalSessionManager.updateSessionPanelSplitEnabled(
            session.id,
            parsed.data.panelSplitEnabled,
          )) ?? updatedSession;
      }
      res.json(
        toSessionListItem(
          updatedSession,
          resolveTerminalStateFromPanels(
            terminalSessionManager,
            options?.terminalStateService,
            updatedSession,
          ),
          toPanelWorkspacePayload(terminalSessionManager, session.id),
        ),
      );
    } catch (error) {
      terminalLogger.error("terminal.session.update.failed", {
        message: "Terminal session update failed",
        terminalSessionId: session.id,
        error,
      });
      res.status(500).json({
        message: "Terminal session update failed",
        error: String(error),
      });
    }
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
    if (
      parsed.data.mode === "codex_slash_command" &&
      !normalizeCodexSlashCommand(parsed.data.data)
    ) {
      res.status(400).json({ message: "Invalid Codex slash command input" });
      return;
    }

    try {
      const inputMode = parsed.data.mode as TerminalInputMode | undefined;
      const paneTarget =
        isTmuxBackedSession(session) && options.tmuxService
          ? (
              await resolvePanelTarget(
                terminalSessionManager,
                session,
                {
                  tmuxService: options.tmuxService,
                  terminalEventService: options.terminalEventService,
                },
                {
                  panelId: parsed.data.panelId,
                  panelAlias: parsed.data.panelAlias,
                  role: parsed.data.role,
                },
                "explicit-or-active",
              )
            ).paneTarget
          : undefined;
      const payload = await sendInputToSession(
        terminalSessionManager,
        options,
        session,
        parsed.data.data,
        inputMode,
        parsed.data.operationId,
        paneTarget,
      );
      if (options?.quickInputService && payload.inputAccepted) {
        try {
          await options.quickInputService.recordRecentInput({
            data: parsed.data.data,
            mode: inputMode,
            projectId: session.projectId,
            terminalSessionId: session.id,
            cwd: session.cwd,
            source: parsed.data.quickInputSource ?? "api_terminal_input",
            acceptedAt: payload.acceptedAt,
          });
        } catch (error) {
          terminalLogger.warn("terminal.quick-input.record.failed", {
            message: "Terminal quick input record failed",
            terminalSessionId: session.id,
            projectId: session.projectId,
            inputMode: inputMode ?? "raw",
            error,
          });
        }
      }
      res.status(200).json(payload);
    } catch (error) {
      if (sendTerminalPanelRouteError(res, error)) {
        return;
      }
      if (isMissingTerminalRuntimeError(error)) {
        terminalSessionManager.markExited(session.id, session.exitCode);
        res.status(409).json({
          message: "Terminal session is not running",
          error: String(error),
        });
        return;
      }
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
      aiDiagnosticLog("terminal interrupt requested", {
        terminalSessionId: session.id,
        operationId: parsed.data.operationId ?? null,
        runtimeKind: isTmuxBackedSession(session) ? "tmux" : "pty",
        interruptSequence: "escape",
      });
      const paneTarget =
        isTmuxBackedSession(session) && options.tmuxService
          ? (
              await resolvePanelTarget(
                terminalSessionManager,
                session,
                {
                  tmuxService: options.tmuxService,
                  terminalEventService: options.terminalEventService,
                },
                {
                  panelId: parsed.data.panelId,
                  panelAlias: parsed.data.panelAlias,
                  role: parsed.data.role,
                },
                "explicit-or-active",
              )
            ).paneTarget
          : undefined;
      const inputPayload = await sendInputToSession(
        terminalSessionManager,
        options,
        session,
        TERMINAL_INTERRUPT_ESCAPE_INPUT,
        undefined,
        parsed.data.operationId,
        paneTarget,
      );
      const payload: SendTerminalInterruptResponse = {
        ...inputPayload,
        interruptAccepted: true,
        interruptSequence: "escape",
      };
      const agent = getTerminalSessionAgent(session);
      if (options.terminalStateService && agent) {
        const terminalState = options.terminalStateService.handleAgentHook(
          session.id,
          agent,
          "Stop",
          {
            projectId: session.projectId,
            reason: "interrupt",
          },
        );
        aiDiagnosticLog("terminal interrupt updated agent state", {
          terminalSessionId: session.id,
          operationId: parsed.data.operationId ?? null,
          state: terminalState.state,
          agent: terminalState.agent,
        });
        terminalLogger.info("terminal.interrupt.agent-state-updated", {
          message: "Terminal interrupt updated agent state",
          terminalSessionId: session.id,
          state: terminalState.state,
          agent: terminalState.agent,
        });
      }
      aiDiagnosticLog("terminal interrupt accepted", {
        terminalSessionId: session.id,
        operationId: parsed.data.operationId ?? null,
        runtimeKind: payload.runtimeKind,
        interruptSequence: payload.interruptSequence,
      });
      res.status(200).json(payload);
    } catch (error) {
      if (sendTerminalPanelRouteError(res, error)) {
        return;
      }
      aiDiagnosticLog("terminal interrupt failed", {
        terminalSessionId: session.id,
        operationId: parsed.data.operationId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
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

    options?.terminalEventService?.record({
      kind: "terminal_session_deleted",
      terminalSessionId: req.params.id,
      projectId: session?.projectId ?? null,
      payload: {
        terminalSessionId: req.params.id,
        projectId: session?.projectId ?? null,
      },
    });
    res.status(204).send();
  });

  return router;
}
