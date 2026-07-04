import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import type {
  CreateTerminalPanelRequest,
  SendTerminalInterruptRequest,
  SendTerminalInputRequest,
  TerminalInputMode,
  TerminalPanelWorkspace,
  UpdateTerminalPanelRequest,
} from "@runweave/shared";
import type {
  TerminalPanelRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../terminal/manager";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import {
  ensureTerminalRuntime,
  isTmuxBackedSession,
  resolveTmuxTarget,
} from "../terminal/runtime-launcher";
import type { TmuxPaneInfo, TmuxPaneTarget, TmuxService } from "../terminal/tmux-service";
import type { TmuxOutputWatcher } from "../terminal/tmux-output-watcher";
import type { TerminalEventService } from "../terminal/terminal-event-service";
import type { TerminalStateService } from "../terminal/terminal-state-service";
import {
  resolveDefaultTerminalArgs,
  resolveDefaultTerminalCommand,
} from "../terminal/default-shell";
import { logger } from "../logging";
import { sendInputToSession } from "./terminal-input-dispatcher";
import {
  buildTerminalInputOperationId,
  sendTerminalInputSchema,
  sendTerminalInterruptSchema,
  TERMINAL_INTERRUPT_ESCAPE_INPUT,
} from "./terminal-session-route-helpers";
import {
  toHistoryPayload,
  toPanelListItem,
  toPanelWorkspacePayload,
} from "./terminal-route-payloads";

interface TerminalPanelRouteOptions {
  ptyService?: PtyService;
  runtimeRegistry?: TerminalRuntimeRegistry;
  tmuxService?: TmuxService;
  tmuxOutputWatcher?: TmuxOutputWatcher;
  terminalEventService?: TerminalEventService;
  terminalStateService?: TerminalStateService;
}

export interface TerminalPanelTargetResolution {
  panel: TerminalPanelRecord;
  paneTarget: TmuxPaneTarget;
}

export class TerminalPanelRouteError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "TerminalPanelRouteError";
  }
}

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

function getSessionOrThrow(
  terminalSessionManager: TerminalSessionManager,
  terminalSessionId: string,
): TerminalSessionRecord {
  const session = terminalSessionManager.getSession(terminalSessionId);
  if (!session) {
    throw new TerminalPanelRouteError(404, "Terminal session not found");
  }
  return session;
}

function requireTmuxSession(
  session: TerminalSessionRecord,
  tmuxService: TmuxService | undefined,
): TmuxService {
  if (!isTmuxBackedSession(session)) {
    throw new TerminalPanelRouteError(
      409,
      "Panel split requires tmux runtime",
    );
  }
  if (!tmuxService) {
    throw new TerminalPanelRouteError(503, "Terminal tmux service unavailable");
  }
  return tmuxService;
}

function buildPaneTarget(
  session: TerminalSessionRecord,
  tmuxService: TmuxService,
  panel: TerminalPanelRecord,
): TmuxPaneTarget {
  return {
    ...resolveTmuxTarget(session, tmuxService),
    paneId: panel.tmuxPaneId,
  };
}

function buildDefaultPanel(
  session: TerminalSessionRecord,
  pane: TmuxPaneInfo,
): TerminalPanelRecord {
  const now = new Date();
  return {
    id: randomUUID(),
    terminalSessionId: session.id,
    alias: "main",
    role: "main",
    agentTeamRunId: null,
    agentTeamWorkerId: null,
    cwd: pane.cwd || session.cwd,
    activeCommand: pane.activeCommand,
    status: "running",
    createdAt: now,
    lastActivityAt: now,
    runtimeKind: "tmux",
    tmuxPaneId: pane.paneId,
  };
}

function buildSplitPanel(
  session: TerminalSessionRecord,
  paneId: string,
  params: {
    panelId: string;
    alias: string | null;
    role: string | null;
    agentTeamRunId: string | null;
    agentTeamWorkerId: string | null;
    cwd: string;
    activeCommand: string | null;
  },
): TerminalPanelRecord {
  const now = new Date();
  return {
    id: params.panelId,
    terminalSessionId: session.id,
    alias: params.alias,
    role: params.role,
    agentTeamRunId: params.agentTeamRunId,
    agentTeamWorkerId: params.agentTeamWorkerId,
    cwd: params.cwd,
    activeCommand: params.activeCommand,
    status: "running",
    createdAt: now,
    lastActivityAt: now,
    runtimeKind: "tmux",
    tmuxPaneId: paneId,
  };
}

function recordPanelEvent(
  terminalSessionManager: TerminalSessionManager,
  terminalEventService: TerminalEventService | undefined,
  session: TerminalSessionRecord,
  kind:
    | "terminal_panel_created"
    | "terminal_panel_updated"
    | "terminal_panel_deleted"
    | "terminal_panel_focused"
    | "terminal_panel_input_sent",
  payload: Record<string, unknown>,
): void {
  const workspace = toPanelWorkspacePayload(terminalSessionManager, session.id);
  if (!workspace) {
    return;
  }
  terminalEventService?.record({
    kind,
    terminalSessionId: session.id,
    projectId: session.projectId,
    payload: {
      ...payload,
      terminalSessionId: session.id,
      workspace,
    } as never,
  });
}

async function ensureTmuxPanelWorkspace(
  terminalSessionManager: TerminalSessionManager,
  session: TerminalSessionRecord,
  tmuxService: TmuxService,
  terminalEventService?: TerminalEventService,
) {
  const target = resolveTmuxTarget(session, tmuxService);
  const panes = await tmuxService.listPanes(target);
  if (panes.length === 0) {
    throw new TerminalPanelRouteError(409, "Terminal tmux session has no panes");
  }

  const paneIds = new Set(panes.map((pane) => pane.paneId));
  const existingPanels = terminalSessionManager.listPanels(session.id);
  let workspace = terminalSessionManager.getPanelWorkspace(session.id);
  let changed = false;
  const panelsByPaneId = new Map<string, TerminalPanelRecord>();
  for (const panel of existingPanels) {
    const previous = panelsByPaneId.get(panel.tmuxPaneId);
    if (!previous) {
      panelsByPaneId.set(panel.tmuxPaneId, panel);
      continue;
    }
    const keepPanel =
      panel.alias || panel.role || previous.status !== "running"
        ? panel
        : previous;
    const dropPanel = keepPanel === panel ? previous : panel;
    await terminalSessionManager.markPanelExited(dropPanel.id);
    await terminalSessionManager.removePanelFromWorkspace(
      session.id,
      dropPanel.id,
      keepPanel.id,
    );
    panelsByPaneId.set(panel.tmuxPaneId, keepPanel);
    recordPanelEvent(
      terminalSessionManager,
      terminalEventService,
      session,
      "terminal_panel_deleted",
      { panelId: dropPanel.id },
    );
    changed = true;
  }
  for (const panel of existingPanels) {
    if (!paneIds.has(panel.tmuxPaneId) && panel.status === "running") {
      await terminalSessionManager.markPanelExited(panel.id);
      await terminalSessionManager.removePanelFromWorkspace(session.id, panel.id);
      recordPanelEvent(
        terminalSessionManager,
        terminalEventService,
        session,
        "terminal_panel_deleted",
        { panelId: panel.id },
      );
      changed = true;
    }
  }

  const livePanelIds: string[] = [];
  for (const pane of panes) {
    const existingPanel = panelsByPaneId.get(pane.paneId);
    if (existingPanel) {
      if (
        existingPanel.cwd !== pane.cwd ||
        existingPanel.activeCommand !== pane.activeCommand ||
        existingPanel.status !== "running"
      ) {
        existingPanel.cwd = pane.cwd || existingPanel.cwd;
        existingPanel.activeCommand = pane.activeCommand;
        existingPanel.status = "running";
        existingPanel.lastActivityAt = new Date();
        await terminalSessionManager.upsertPanel(existingPanel);
        changed = true;
      }
      livePanelIds.push(existingPanel.id);
      continue;
    }

    const panel =
      livePanelIds.length === 0 && existingPanels.length === 0
        ? buildDefaultPanel(session, pane)
        : buildSplitPanel(session, pane.paneId, {
            panelId: randomUUID(),
            alias: null,
            role: null,
            agentTeamRunId: null,
            agentTeamWorkerId: null,
            cwd: pane.cwd || session.cwd,
            activeCommand: pane.activeCommand,
          });
    await terminalSessionManager.upsertPanel(panel);
    livePanelIds.push(panel.id);
    changed = true;
  }

  const activePane = panes.find((pane) => pane.active) ?? panes[0]!;
  const activePanelId =
    terminalSessionManager
      .listPanels(session.id)
      .find((panel) => panel.tmuxPaneId === activePane.paneId)?.id ??
    livePanelIds[0]!;

  if (
    !workspace ||
    workspace.activePanelId !== activePanelId ||
    workspace.panelIds.join("\0") !== livePanelIds.join("\0")
  ) {
    workspace = await terminalSessionManager.upsertPanelWorkspace({
      terminalSessionId: session.id,
      activePanelId,
      panelIds: livePanelIds,
      renderMode: "tmux-native",
    });
    changed = true;
  }

  if (changed) {
    const activePanel = terminalSessionManager.getPanel(workspace.activePanelId);
    if (activePanel) {
      recordPanelEvent(
        terminalSessionManager,
        terminalEventService,
        session,
        "terminal_panel_updated",
        {
          panel: toPanelListItem(activePanel, workspace.activePanelId),
        },
      );
    }
  }

  return workspace;
}

export async function ensureTerminalPanelWorkspace(
  terminalSessionManager: TerminalSessionManager,
  session: TerminalSessionRecord,
  options: Pick<
    TerminalPanelRouteOptions,
    | "ptyService"
    | "runtimeRegistry"
    | "tmuxService"
    | "tmuxOutputWatcher"
    | "terminalEventService"
  >,
) {
  if (!isTmuxBackedSession(session)) {
    return {
      terminalSessionId: session.id,
      activePanelId: "default",
      panels: [
        {
          panelId: "default",
          terminalSessionId: session.id,
          alias: "main",
          role: "main",
          cwd: session.cwd,
          activeCommand: session.activeCommand,
          status: session.status,
          createdAt: session.createdAt.toISOString(),
          lastActivityAt: session.lastActivityAt.toISOString(),
          exitCode: session.exitCode,
          focused: true,
        },
      ],
      renderMode: "tmux-native" as const,
    };
  }

  const tmuxService = requireTmuxSession(session, options.tmuxService);
  let currentSession =
    terminalSessionManager.getSession(session.id) ?? session;
  const hadTmuxSession = await tmuxService.hasSession(
    resolveTmuxTarget(currentSession, tmuxService),
  );
  if (!hadTmuxSession && options.runtimeRegistry && options.ptyService) {
    await options.runtimeRegistry.disposeRuntime(currentSession.id);
    await ensureTerminalRuntime({
      session: currentSession,
      terminalSessionManager,
      runtimeRegistry: options.runtimeRegistry,
      ptyService: options.ptyService,
      tmuxService,
      tmuxOutputWatcher: options.tmuxOutputWatcher,
    });
    await terminalSessionManager.clearPanelsForSession(currentSession.id);
    currentSession =
      terminalSessionManager.getSession(currentSession.id) ?? currentSession;
  }
  await ensureTmuxPanelWorkspace(
    terminalSessionManager,
    currentSession,
    tmuxService,
    options.terminalEventService,
  );
  const workspace = toPanelWorkspacePayload(
    terminalSessionManager,
    currentSession.id,
  );
  if (!workspace) {
    throw new TerminalPanelRouteError(500, "Terminal panel workspace missing");
  }
  return workspace;
}

async function syncSelectedPaneToActivePanel(
  terminalSessionManager: TerminalSessionManager,
  session: TerminalSessionRecord,
  tmuxService: TmuxService,
  terminalEventService?: TerminalEventService,
): Promise<TerminalPanelRecord | null> {
  await ensureTmuxPanelWorkspace(
    terminalSessionManager,
    session,
    tmuxService,
    terminalEventService,
  );
  const selectedPaneId = await tmuxService.readSelectedPane(
    resolveTmuxTarget(session, tmuxService),
  );
  if (!selectedPaneId) {
    return null;
  }
  const selectedPanel =
    terminalSessionManager
      .listPanels(session.id)
      .find((panel) => panel.tmuxPaneId === selectedPaneId) ?? null;
  if (!selectedPanel) {
    return null;
  }
  const previousActive =
    terminalSessionManager.getPanelWorkspace(session.id)?.activePanelId;
  await terminalSessionManager.focusPanel(session.id, selectedPanel.id);
  if (previousActive !== selectedPanel.id) {
    recordPanelEvent(
      terminalSessionManager,
      terminalEventService,
      session,
      "terminal_panel_focused",
      {
        panelId: selectedPanel.id,
        alias: selectedPanel.alias,
        role: selectedPanel.role,
        source: "tmux",
      },
    );
  }
  return selectedPanel;
}

function findPanelByAliasOrRole(
  panels: TerminalPanelRecord[],
  field: "alias" | "role",
  value: string,
): TerminalPanelRecord {
  const matches = panels.filter((panel) => panel[field] === value);
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new TerminalPanelRouteError(409, `Multiple panels match ${field}`, {
      panels: matches.map((panel) => ({
        panelId: panel.id,
        alias: panel.alias,
        role: panel.role,
      })),
    });
  }
  throw new TerminalPanelRouteError(404, "Terminal panel not found");
}

export async function resolvePanelTarget(
  terminalSessionManager: TerminalSessionManager,
  session: TerminalSessionRecord,
  options: Pick<TerminalPanelRouteOptions, "tmuxService" | "terminalEventService">,
  request: {
    panelId?: string;
    panelAlias?: string;
    role?: string;
  },
  mode: "explicit-or-active" | "default-history",
): Promise<TerminalPanelTargetResolution> {
  const tmuxService = requireTmuxSession(session, options.tmuxService);
  await ensureTmuxPanelWorkspace(
    terminalSessionManager,
    session,
    tmuxService,
    options.terminalEventService,
  );
  const panels = terminalSessionManager.listPanels(session.id);
  let panel: TerminalPanelRecord | undefined;
  if (request.panelId) {
    panel = panels.find((candidate) => candidate.id === request.panelId);
  } else if (request.panelAlias) {
    panel = findPanelByAliasOrRole(panels, "alias", request.panelAlias);
  } else if (request.role) {
    panel = findPanelByAliasOrRole(panels, "role", request.role);
  } else if (mode === "default-history") {
    panel = panels.find((candidate) => candidate.alias === "main") ?? panels[0];
  } else {
    panel =
      (await syncSelectedPaneToActivePanel(
        terminalSessionManager,
        session,
        tmuxService,
        options.terminalEventService,
      )) ??
      panels.find(
        (candidate) =>
          candidate.id ===
          terminalSessionManager.getPanelWorkspace(session.id)?.activePanelId,
      ) ??
      panels[0];
  }

  if (!panel) {
    throw new TerminalPanelRouteError(404, "Terminal panel not found");
  }
  return {
    panel,
    paneTarget: buildPaneTarget(session, tmuxService, panel),
  };
}

function assertUniqueAlias(
  panels: TerminalPanelRecord[],
  alias: string | null,
): void {
  if (!alias) {
    return;
  }
  if (panels.some((panel) => panel.alias === alias)) {
    throw new TerminalPanelRouteError(409, "Terminal panel alias already exists");
  }
}

function assertUniqueRole(
  panels: TerminalPanelRecord[],
  role: string | null,
): void {
  if (!role) {
    return;
  }
  if (panels.some((panel) => panel.role === role)) {
    throw new TerminalPanelRouteError(409, "Terminal panel role already exists");
  }
}

export function sendTerminalPanelRouteError(
  res: Response,
  error: unknown,
): boolean {
  if (error instanceof TerminalPanelRouteError) {
    res.status(error.statusCode).json({
      message: error.message,
      details: error.details,
    });
    return true;
  }
  return false;
}

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

export interface CreateTerminalPanelSplitParams {
  sourcePanelId?: string;
  direction: "right" | "down";
  alias?: string | null;
  role?: string | null;
  agentTeamRunId?: string | null;
  agentTeamWorkerId?: string | null;
  command?: string;
  args?: string[];
  cwd?: string;
  focus?: boolean;
}

/**
 * Split a new tmux pane inside a terminal session and register it as a panel.
 * Shared by the panel HTTP route and the agent-team run service (worker panes).
 */
export async function createTerminalPanelSplit(
  terminalSessionManager: TerminalSessionManager,
  session: TerminalSessionRecord,
  options: TerminalPanelRouteOptions,
  params: CreateTerminalPanelSplitParams,
): Promise<{ panel: TerminalPanelRecord; workspace: TerminalPanelWorkspace }> {
  const tmuxService = requireTmuxSession(session, options.tmuxService);
  if (!options.runtimeRegistry || !options.ptyService) {
    throw new TerminalPanelRouteError(
      503,
      "Terminal runtime service unavailable",
    );
  }
  await ensureTerminalRuntime({
    session,
    terminalSessionManager,
    runtimeRegistry: options.runtimeRegistry,
    ptyService: options.ptyService,
    tmuxService,
    tmuxOutputWatcher: options.tmuxOutputWatcher,
  });
  await ensureTmuxPanelWorkspace(
    terminalSessionManager,
    session,
    tmuxService,
    options.terminalEventService,
  );
  const panels = terminalSessionManager.listPanels(session.id);
  const alias = params.alias?.trim() || null;
  const role = params.role?.trim() || null;
  const agentTeamRunId = params.agentTeamRunId?.trim() || null;
  const agentTeamWorkerId = params.agentTeamWorkerId?.trim() || null;
  assertUniqueAlias(panels, alias);
  assertUniqueRole(panels, role);
  const sourcePanel =
    panels.find((panel) => panel.id === params.sourcePanelId) ??
    panels.find(
      (panel) =>
        panel.id ===
        terminalSessionManager.getPanelWorkspace(session.id)?.activePanelId,
    ) ??
    panels[0];
  if (!sourcePanel) {
    throw new TerminalPanelRouteError(404, "Source panel not found");
  }

  const panelId = randomUUID();
  const command = params.command?.trim() || resolveDefaultTerminalCommand();
  const args = params.args ?? resolveDefaultTerminalArgs(command);
  const cwd = params.cwd?.trim() || sourcePanel.cwd || session.cwd;
  const splitTarget = await tmuxService.splitPane(
    buildPaneTarget(session, tmuxService, sourcePanel),
    {
      direction: params.direction,
      cwd,
      command,
      args,
      env: {
        RUNWEAVE_TERMINAL_SESSION_ID: session.id,
        RUNWEAVE_TERMINAL_PANEL_ID: panelId,
      },
    },
  );
  const provisionalPanel = await terminalSessionManager.upsertPanel(
    buildSplitPanel(session, splitTarget.paneId, {
      panelId,
      alias,
      role,
      agentTeamRunId,
      agentTeamWorkerId,
      cwd,
      activeCommand: null,
    }),
  );
  const previousWorkspace = terminalSessionManager.getPanelWorkspace(session.id);
  await terminalSessionManager.upsertPanelWorkspace({
    terminalSessionId: session.id,
    activePanelId:
      params.focus === false
        ? previousWorkspace?.activePanelId || sourcePanel.id
        : provisionalPanel.id,
    panelIds: [...(previousWorkspace?.panelIds ?? []), provisionalPanel.id],
    renderMode: "tmux-native",
  });
  await tmuxService.waitForPaneReady(splitTarget);
  const metadata = await tmuxService.readPaneMetadata(splitTarget, command);
  provisionalPanel.cwd = metadata?.cwd || cwd;
  provisionalPanel.activeCommand = metadata?.activeCommand ?? null;
  const panel = await terminalSessionManager.upsertPanel(provisionalPanel);
  if (params.focus !== false) {
    await tmuxService.selectPane(splitTarget);
  }
  const workspace = toPanelWorkspacePayload(terminalSessionManager, session.id);
  recordPanelEvent(
    terminalSessionManager,
    options.terminalEventService,
    session,
    "terminal_panel_created",
    {
      panel: toPanelListItem(panel, workspace?.activePanelId ?? panel.id),
    },
  );
  if (!workspace) {
    throw new TerminalPanelRouteError(500, "Terminal panel workspace missing");
  }
  return { panel, workspace };
}

export function registerTerminalPanelRoutes(
  router: Router,
  terminalSessionManager: TerminalSessionManager,
  options: TerminalPanelRouteOptions,
): void {
  router.get("/session/:id/panels", async (req, res) => {
    try {
      const session = getSessionOrThrow(terminalSessionManager, req.params.id);
      res.json(
        await ensureTerminalPanelWorkspace(terminalSessionManager, session, {
          ptyService: options.ptyService,
          runtimeRegistry: options.runtimeRegistry,
          tmuxService: options.tmuxService,
          tmuxOutputWatcher: options.tmuxOutputWatcher,
          terminalEventService: options.terminalEventService,
        }),
      );
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
      res.status(201).json(workspace);
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
      res.json(toPanelWorkspacePayload(terminalSessionManager, session.id));
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
      await terminalSessionManager.markPanelExited(panel.id);
      await terminalSessionManager.removePanelFromWorkspace(session.id, panel.id);
      recordPanelEvent(
        terminalSessionManager,
        options.terminalEventService,
        session,
        "terminal_panel_deleted",
        { panelId: panel.id },
      );
      res.status(200).json(toPanelWorkspacePayload(terminalSessionManager, session.id));
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
      const operationId = parsed.data.operationId ?? buildTerminalInputOperationId();
      const payload = await sendInputToSession(
        terminalSessionManager,
        options,
        session,
        parsed.data.data,
        parsed.data.mode as TerminalInputMode | undefined,
        operationId,
        paneTarget,
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
