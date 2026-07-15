import { Router, type Response } from "express";
import { z } from "zod";
import type { SendTerminalInterruptRequest, SendTerminalInputRequest, TerminalInputMode } from "@runweave/shared/terminal/input";
import type { PrepareTerminalAgentRequest } from "@runweave/shared/terminal/agent-preparation";
import type { CreateTerminalPanelRequest, ResizeTerminalPanelRequest, UpdateTerminalPanelRequest } from "@runweave/shared/terminal/panel";
import type { TerminalSessionManager } from "../terminal/manager";
import { logger } from "../logging";
import { sendInputToSession } from "../terminal/application/input-dispatcher";
import {
  buildTerminalInputOperationId,
  sendTerminalInputSchema,
  sendTerminalInterruptSchema,
  TERMINAL_INTERRUPT_ESCAPE_INPUT,
} from "./terminal-session-route-helpers";
import {
  getSessionOrThrow,
  sendTerminalPanelRouteError,
  TerminalPanelRouteError,
  type TerminalPanelRouteOptions,
} from "./terminal-panel-common";
import {
  backfillSessionAgentMetadataToPrimaryPanel,
  recordPanelEvent,
  syncSinglePanelMetadataToSession,
} from "../terminal/application/panel-metadata";
import { createTerminalPanelSplit } from "../terminal/application/panel-split";
import { prepareTerminalAgent } from "../terminal/application/agent-preparation";
import {
  ensureTerminalPanelWorkspace,
  withPaneGeometry,
} from "../terminal/application/panel-workspace";
import { resolvePanelTarget } from "../terminal/application/panel-targets";
import {
  toHistoryPayload,
  toPanelWorkspacePayload,
} from "../terminal/application/payloads";

export {
  getSessionOrThrow,
  sendTerminalPanelRouteError,
  TerminalPanelRouteError,
  type TerminalPanelRouteOptions,
  type TerminalPanelTargetResolution,
} from "./terminal-panel-common";
export {
  createTerminalPanelSplit,
  type CreateTerminalPanelSplitParams,
} from "../terminal/application/panel-split";
export { ensureTerminalPanelWorkspace } from "../terminal/application/panel-workspace";
export { resolvePanelTarget } from "../terminal/application/panel-targets";

const panelLogger = logger.child({ component: "terminal" });

const createTerminalPanelSchema = z
  .object({
    sourcePanelId: z.string().trim().min(1).optional(),
    direction: z.enum(["right", "down"]),
    alias: z.string().trim().min(1).max(80).nullable().optional(),
    role: z.string().trim().min(1).max(80).nullable().optional(),
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().trim().min(1).optional(),
    focus: z.boolean().optional(),
  })
  .strict();

const updateTerminalPanelSchema = z
  .object({
    focus: z.boolean().optional(),
  })
  .strict();

const resizeTerminalPanelSchema = z
  .object({
    direction: z.enum(["left", "right", "up", "down"]),
    cells: z.number().int().min(1).max(500),
  })
  .strict();

const prepareTerminalAgentSchema = z
  .object({
    agent: z.enum(["codex", "traex"]),
    prompt: z.string().trim().min(1).max(8_000),
    panelId: z.string().trim().min(1).optional(),
    cwd: z.string().trim().min(1).optional(),
    role: z.string().trim().min(1).max(80).nullable().optional(),
    alias: z.string().trim().min(1).max(80).nullable().optional(),
    sourcePanelId: z.string().trim().min(1).optional(),
    direction: z.enum(["right", "down"]).optional(),
    focus: z.boolean().optional(),
    command: z.string().trim().min(1).optional(),
    commandLine: z.string().trim().min(1).max(8_000).optional(),
    args: z.array(z.string()).optional(),
    resumeThreadId: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().min(0).max(600_000).optional(),
  })
  .strict();

function sendRouteError(res: Response, error: unknown): void {
  if (sendTerminalPanelRouteError(res, error)) {
    return;
  }
  panelLogger.error("terminal.panel.route.failed", {
    message: "Terminal panel route failed",
    error,
  });
  res.status(500).json({
    message: "Terminal panel route failed",
    error: String(error),
  });
}

export function registerTerminalPanelRoutes(
  router: Router,
  terminalSessionManager: TerminalSessionManager,
  options: TerminalPanelRouteOptions,
): void {
  router.post("/session/:id/agent/prepare", async (req, res) => {
    const parsed = prepareTerminalAgentSchema.safeParse(
      req.body as PrepareTerminalAgentRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }
    try {
      const session = getSessionOrThrow(terminalSessionManager, req.params.id);
      const result = await prepareTerminalAgent(
        terminalSessionManager,
        session,
        options,
        parsed.data,
      );
      res.status(result.createdPanel ? 201 : 200).json(result);
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  router.get("/session/:id/panels", async (req, res) => {
    try {
      const session = getSessionOrThrow(terminalSessionManager, req.params.id);
      const workspace = await ensureTerminalPanelWorkspace(
        terminalSessionManager,
        session,
        {
          ptyService: options.ptyService,
          runtimeRegistry: options.runtimeRegistry,
          tmuxService: options.tmuxService,
          tmuxOutputWatcher: options.tmuxOutputWatcher,
          terminalEventService: options.terminalEventService,
        },
      );
      res.json(await withPaneGeometry(session, options.tmuxService, workspace));
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  router.post("/session/:id/panels", async (req, res) => {
    const parsed = createTerminalPanelSchema.safeParse(
      req.body as CreateTerminalPanelRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }
    try {
      const session = getSessionOrThrow(terminalSessionManager, req.params.id);
      const { workspace } = await createTerminalPanelSplit(
        terminalSessionManager,
        session,
        options,
        {
          sourcePanelId: parsed.data.sourcePanelId,
          direction: parsed.data.direction,
          alias: parsed.data.alias,
          role: parsed.data.role,
          command: parsed.data.command,
          args: parsed.data.args,
          cwd: parsed.data.cwd,
          focus: parsed.data.focus,
        },
      );
      res
        .status(201)
        .json(await withPaneGeometry(session, options.tmuxService, workspace));
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  router.patch("/session/:id/panels/:panelId", async (req, res) => {
    const parsed = updateTerminalPanelSchema.safeParse(
      req.body as UpdateTerminalPanelRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }
    try {
      const session = getSessionOrThrow(terminalSessionManager, req.params.id);
      const { panel, paneTarget } = await resolvePanelTarget(
        terminalSessionManager,
        session,
        options,
        { panelId: req.params.panelId },
        "explicit-or-active",
      );
      if (parsed.data.focus) {
        await options.tmuxService!.selectPane(paneTarget);
        await terminalSessionManager.focusPanel(session.id, panel.id);
        recordPanelEvent(
          terminalSessionManager,
          options.terminalEventService,
          session,
          "terminal_panel_focused",
          {
            panelId: panel.id,
            alias: panel.alias,
            role: panel.role,
            source: "ui",
          },
        );
      }
      res.json(
        await withPaneGeometry(
          session,
          options.tmuxService,
          toPanelWorkspacePayload(terminalSessionManager, session.id),
        ),
      );
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  router.delete("/session/:id/panels/:panelId", async (req, res) => {
    try {
      const session = getSessionOrThrow(terminalSessionManager, req.params.id);
      const { panel, paneTarget } = await resolvePanelTarget(
        terminalSessionManager,
        session,
        options,
        { panelId: req.params.panelId },
        "explicit-or-active",
      );
      const workspace = terminalSessionManager.getPanelWorkspace(session.id);
      if (!workspace || workspace.panelIds.length <= 1) {
        throw new TerminalPanelRouteError(
          409,
          "Cannot close the last terminal panel",
        );
      }
      await options.tmuxService!.killPane(paneTarget);
      await options.tmuxOutputWatcher?.unwatchPane(
        session.id,
        paneTarget.paneId,
      );
      await terminalSessionManager.markPanelExited(panel.id);
      const nextWorkspace =
        await terminalSessionManager.removePanelFromWorkspace(
          session.id,
          panel.id,
        );
      if (nextWorkspace?.panelIds.length === 1) {
        const remainingPanel = terminalSessionManager.getPanel(
          nextWorkspace.panelIds[0]!,
        );
        if (remainingPanel) {
          const syncedFromPanel = await syncSinglePanelMetadataToSession(
            terminalSessionManager,
            session,
            remainingPanel,
          );
          if (!syncedFromPanel) {
            await backfillSessionAgentMetadataToPrimaryPanel(
              terminalSessionManager,
              session,
              remainingPanel,
            );
          }
        }
      }
      recordPanelEvent(
        terminalSessionManager,
        options.terminalEventService,
        session,
        "terminal_panel_deleted",
        { panelId: panel.id },
      );
      res
        .status(200)
        .json(
          await withPaneGeometry(
            session,
            options.tmuxService,
            toPanelWorkspacePayload(terminalSessionManager, session.id),
          ),
        );
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  router.post("/session/:id/panels/:panelId/resize", async (req, res) => {
    const parsed = resizeTerminalPanelSchema.safeParse(
      req.body as ResizeTerminalPanelRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }
    try {
      const session = getSessionOrThrow(terminalSessionManager, req.params.id);
      const { paneTarget } = await resolvePanelTarget(
        terminalSessionManager,
        session,
        options,
        { panelId: req.params.panelId },
        "explicit-or-active",
      );
      await options.tmuxService!.resizePane(paneTarget, {
        direction: parsed.data.direction,
        cells: parsed.data.cells,
      });
      res.json(
        await withPaneGeometry(
          session,
          options.tmuxService,
          toPanelWorkspacePayload(terminalSessionManager, session.id),
        ),
      );
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  router.post("/session/:id/panels/:panelId/input", async (req, res) => {
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
    try {
      const session = getSessionOrThrow(terminalSessionManager, req.params.id);
      const { panel, paneTarget } = await resolvePanelTarget(
        terminalSessionManager,
        session,
        options,
        { panelId: req.params.panelId },
        "explicit-or-active",
      );
      const operationId =
        parsed.data.operationId ?? buildTerminalInputOperationId();
      const payload = await sendInputToSession(
        terminalSessionManager,
        options,
        session,
        parsed.data.data,
        parsed.data.mode as TerminalInputMode | undefined,
        operationId,
        paneTarget,
        parsed.data.submit,
      );
      recordPanelEvent(
        terminalSessionManager,
        options.terminalEventService,
        session,
        "terminal_panel_input_sent",
        {
          panelId: panel.id,
          alias: panel.alias,
          role: panel.role,
          operationId,
        },
      );
      res.status(200).json(payload);
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  router.post("/session/:id/panels/:panelId/interrupt", async (req, res) => {
    const parsed = sendTerminalInterruptSchema.safeParse(
      req.body as SendTerminalInterruptRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }
    try {
      const session = getSessionOrThrow(terminalSessionManager, req.params.id);
      const { paneTarget } = await resolvePanelTarget(
        terminalSessionManager,
        session,
        options,
        { panelId: req.params.panelId },
        "explicit-or-active",
      );
      const payload = await sendInputToSession(
        terminalSessionManager,
        options,
        session,
        TERMINAL_INTERRUPT_ESCAPE_INPUT,
        undefined,
        parsed.data.operationId,
        paneTarget,
      );
      res.status(200).json({
        ...payload,
        interruptAccepted: true,
        interruptSequence: "escape",
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  router.get("/session/:id/panels/:panelId/history", async (req, res) => {
    try {
      const session = getSessionOrThrow(terminalSessionManager, req.params.id);
      const { paneTarget } = await resolvePanelTarget(
        terminalSessionManager,
        session,
        options,
        { panelId: req.params.panelId },
        "default-history",
      );
      const capture = await options.tmuxService!.capturePane(paneTarget);
      res.json(toHistoryPayload(session, capture.data, capture.sourceCols));
    } catch (error) {
      sendRouteError(res, error);
    }
  });
}
