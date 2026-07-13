import { randomUUID } from "node:crypto";
import type { TerminalPanelWorkspace } from "@runweave/shared/terminal-protocol";
import type {
  TerminalPanelRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager";
import {
  ensureTerminalRuntime,
  isTmuxBackedSession,
  resolveTmuxTarget,
} from "../runtime-launcher";
import type { TmuxPaneInfo, TmuxService } from "../tmux-service";
import type { TerminalEventService } from "../terminal-event-service";
import { hasAgentReadyPrompt } from "../terminal-state-service";
import { logger } from "../../logging";
import {
  requireTmuxSession,
  TerminalPanelError,
  type TerminalPanelOptions,
} from "./panel-common";
import {
  backfillSessionAgentMetadataToPrimaryPanel,
  buildDefaultPanel,
  buildSplitPanel,
  clearMultiPanelMetadataFromSession,
  getPanelTerminalStateForActiveCommand,
  isEnvironmentAssignmentOnlyActiveCommand,
  recordPanelEvent,
  resolveEffectivePanelActiveCommand,
  shouldBackfillSessionAgentMetadataToMainPanel,
  syncSinglePanelMetadataToSession,
} from "./panel-metadata";
import { toPanelListItem, toPanelWorkspacePayload } from "./payloads";

const panelLogger = logger.child({ component: "terminal" });

export async function ensureTmuxPanelWorkspace(
  terminalSessionManager: TerminalSessionManager,
  session: TerminalSessionRecord,
  tmuxService: TmuxService,
  terminalEventService?: TerminalEventService,
) {
  const target = resolveTmuxTarget(session, tmuxService);
  const panes = await tmuxService.listPanes(target);
  if (panes.length === 0) {
    throw new TerminalPanelError(409, "Terminal tmux session has no panes");
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
      await terminalSessionManager.removePanelFromWorkspace(
        session.id,
        panel.id,
      );
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
      const effectiveActiveCommand = resolveEffectivePanelActiveCommand(
        pane,
        existingPanel.activeCommand,
      );
      let nextTerminalState = getPanelTerminalStateForActiveCommand(
        effectiveActiveCommand,
        existingPanel.terminalState,
      );
      if (
        nextTerminalState.state === "agent_starting" &&
        nextTerminalState.agent
      ) {
        try {
          const capture = await tmuxService.capturePane({
            ...target,
            paneId: pane.paneId,
          });
          if (hasAgentReadyPrompt(nextTerminalState.agent, capture.data)) {
            nextTerminalState = {
              state: "agent_idle",
              agent: nextTerminalState.agent,
            };
          }
        } catch (error) {
          panelLogger.warn("terminal.panel.ready-prompt.capture-failed", {
            message: "Could not refresh terminal panel state from pane output",
            terminalSessionId: session.id,
            panelId: existingPanel.id,
            tmuxPaneId: pane.paneId,
            error,
          });
        }
      }
      const storedThreadProvider =
        existingPanel.threadProvider ??
        (existingPanel.threadId ? "codex" : undefined);
      const shouldClearAgentThreadMetadata =
        Boolean(existingPanel.threadId || existingPanel.preview) &&
        nextTerminalState.agent !== storedThreadProvider &&
        !isEnvironmentAssignmentOnlyActiveCommand(effectiveActiveCommand);
      const shouldBackfillSessionAgentMetadata =
        shouldBackfillSessionAgentMetadataToMainPanel(
          session,
          existingPanel,
          nextTerminalState,
          existingPanels,
        );
      const terminalStateChanged =
        existingPanel.terminalState?.state !== nextTerminalState.state ||
        existingPanel.terminalState.agent !== nextTerminalState.agent;
      if (
        existingPanel.cwd !== pane.cwd ||
        existingPanel.activeCommand !== effectiveActiveCommand ||
        existingPanel.status !== "running" ||
        terminalStateChanged ||
        shouldClearAgentThreadMetadata ||
        shouldBackfillSessionAgentMetadata
      ) {
        const updatedAt = new Date();
        existingPanel.cwd = pane.cwd || existingPanel.cwd;
        existingPanel.activeCommand = effectiveActiveCommand;
        existingPanel.terminalState = nextTerminalState;
        if (shouldClearAgentThreadMetadata) {
          if (existingPanel.threadId) {
            existingPanel.lastThreadId = existingPanel.threadId;
            existingPanel.lastThreadProvider = storedThreadProvider;
            existingPanel.lastThreadStatus = "idle";
            existingPanel.lastThreadUpdatedAt = updatedAt;
          }
          delete existingPanel.threadId;
          delete existingPanel.threadProvider;
          delete existingPanel.preview;
        } else if (shouldBackfillSessionAgentMetadata) {
          await backfillSessionAgentMetadataToPrimaryPanel(
            terminalSessionManager,
            session,
            existingPanel,
          );
        }
        existingPanel.status = "running";
        existingPanel.lastActivityAt = updatedAt;
        await terminalSessionManager.upsertPanel(existingPanel);
        changed = true;
      }
      await syncTmuxPanePanelId(
        tmuxService,
        target,
        pane,
        existingPanel.id,
      );
      livePanelIds.push(existingPanel.id);
      continue;
    }

    const panel =
      livePanelIds.length === 0 &&
      !existingPanels.some(
        (existingPanel) => existingPanel.status === "running",
      )
        ? buildDefaultPanel(session, pane)
        : buildSplitPanel(session, pane.paneId, {
            panelId: randomUUID(),
            alias: null,
            role: null,
            agentTeamRunId: null,
            agentTeamWorkerId: null,
            cwd: pane.cwd || session.cwd,
            activeCommand: resolveEffectivePanelActiveCommand(
              pane,
              session.activeCommand,
            ),
          });
    await terminalSessionManager.upsertPanel(panel);
    await syncTmuxPanePanelId(tmuxService, target, pane, panel.id);
    livePanelIds.push(panel.id);
    changed = true;
  }

  const runningPanels = terminalSessionManager
    .listPanels(session.id)
    .filter((panel) => panel.status === "running");
  if (runningPanels.length === 1) {
    changed =
      (await syncSinglePanelMetadataToSession(
        terminalSessionManager,
        session,
        runningPanels[0]!,
      )) || changed;
  } else if (runningPanels.length > 1) {
    changed =
      (await clearMultiPanelMetadataFromSession(
        terminalSessionManager,
        session,
        runningPanels,
      )) || changed;
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
    const activePanel = terminalSessionManager.getPanel(
      workspace.activePanelId,
    );
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

async function syncTmuxPanePanelId(
  tmuxService: TmuxService,
  target: ReturnType<TmuxService["buildTarget"]>,
  pane: TmuxPaneInfo,
  panelId: string,
): Promise<void> {
  if (pane.runweavePanelId === panelId) {
    return;
  }
  await tmuxService.setPanePanelId(
    { ...target, paneId: pane.paneId },
    panelId,
  );
}

export async function ensureTerminalPanelWorkspace(
  terminalSessionManager: TerminalSessionManager,
  session: TerminalSessionRecord,
  options: Pick<
    TerminalPanelOptions,
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
  let currentSession = terminalSessionManager.getSession(session.id) ?? session;
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
    throw new TerminalPanelError(500, "Terminal panel workspace missing");
  }
  return workspace;
}

/**
 * Attach live tmux pane geometry (cell units) to a workspace payload so the
 * frontend can position resize handles. Best-effort: on any tmux failure the
 * workspace is returned unchanged (panels simply lack `geometry`).
 */
export async function withPaneGeometry(
  session: TerminalSessionRecord,
  tmuxService: TmuxService | undefined,
  workspace: TerminalPanelWorkspace | null,
): Promise<TerminalPanelWorkspace | null> {
  if (!workspace || !tmuxService || !isTmuxBackedSession(session)) {
    return workspace;
  }
  let panes: TmuxPaneInfo[];
  try {
    panes = await tmuxService.listPanes(
      resolveTmuxTarget(session, tmuxService),
    );
  } catch (error) {
    panelLogger.warn("terminal.panel.geometry.failed", {
      message: "Could not read tmux pane geometry",
      terminalSessionId: session.id,
      error,
    });
    return workspace;
  }
  const geometryByPaneId = new Map(panes.map((pane) => [pane.paneId, pane]));
  return {
    ...workspace,
    panels: workspace.panels.map((panel) => {
      const pane = panel.tmuxPaneId
        ? geometryByPaneId.get(panel.tmuxPaneId)
        : undefined;
      if (!pane) {
        return panel;
      }
      return {
        ...panel,
        geometry: {
          paneLeft: pane.paneLeft,
          paneTop: pane.paneTop,
          paneWidth: pane.paneWidth,
          paneHeight: pane.paneHeight,
          windowWidth: pane.windowWidth,
          windowHeight: pane.windowHeight,
        },
      };
    }),
  };
}
