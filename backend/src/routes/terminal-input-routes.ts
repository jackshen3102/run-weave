import type { Router } from "express";
import type {
  SendTerminalInterruptRequest,
  SendTerminalInterruptResponse,
  SendTerminalInputRequest,
  TerminalInputMode,
} from "@runweave/shared/terminal/input";
import { aiDiagnosticLog } from "../diagnostic-logs/recorder";
import { logger } from "../logging";
import type { TerminalSessionManager } from "../terminal/manager";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import type { TerminalStateService } from "../terminal/terminal-state-service";
import type { TerminalEventService } from "../terminal/terminal-event-service";
import type { TmuxService } from "../terminal/tmux-service";
import type { TmuxOutputWatcher } from "../terminal/tmux-output-watcher";
import type { TerminalQuickInputService } from "../terminal/quick-input-service";
import { isTmuxBackedSession } from "../terminal/runtime-launcher";
import {
  isMissingTerminalRuntimeError,
  normalizeCodexSlashCommand,
  sendInputToSession,
} from "../terminal/application/input-dispatcher";
import { getTerminalSessionAgent } from "../terminal/terminal-state-service";
import {
  sendTerminalInputSchema,
  sendTerminalInterruptSchema,
  TERMINAL_INTERRUPT_ESCAPE_INPUT,
} from "./terminal-session-route-helpers";
import {
  resolvePanelTarget,
  sendTerminalPanelRouteError,
} from "./terminal-panel-routes";
import { registerTerminalClipboardImageRoutes } from "./terminal-clipboard-image-routes";

const terminalLogger = logger.child({ component: "terminal" });

interface TerminalInputRouteOptions {
  ptyService?: PtyService;
  runtimeRegistry?: TerminalRuntimeRegistry;
  tmuxService?: TmuxService;
  tmuxOutputWatcher?: TmuxOutputWatcher;
  terminalEventService?: TerminalEventService;
  terminalStateService?: TerminalStateService;
  quickInputService?: TerminalQuickInputService;
}

export function registerTerminalInputRoutes(
  router: Router,
  terminalSessionManager: TerminalSessionManager,
  options?: TerminalInputRouteOptions,
): void {
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
    if (
      parsed.data.quickInputSource === "web_browser_annotation" &&
      parsed.data.mode !== "prompt_paste"
    ) {
      res.status(400).json({
        message: "Browser comments require prompt_paste input mode",
      });
      return;
    }

    try {
      const inputMode = parsed.data.mode as TerminalInputMode | undefined;
      const panelTarget =
        isTmuxBackedSession(session) && options.tmuxService
          ? await resolvePanelTarget(
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
          : undefined;
      if (
        parsed.data.quickInputSource === "web_browser_annotation" &&
        !getTerminalSessionAgent(panelTarget?.panel ?? session)
      ) {
        res.status(409).json({
          message: "Browser comments require an active Agent terminal",
        });
        return;
      }
      const payload = await sendInputToSession(
        terminalSessionManager,
        options,
        session,
        parsed.data.data,
        inputMode,
        parsed.data.operationId,
        panelTarget?.paneTarget,
        parsed.data.submit,
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
}
