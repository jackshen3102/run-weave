import { randomUUID } from "node:crypto";
import type { TerminalPanelWorkspace } from "@runweave/shared/terminal-protocol";
import type {
  TerminalPanelRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager";
import { ensureTerminalRuntime } from "../runtime-launcher";
import {
  resolveDefaultTerminalArgs,
  resolveDefaultTerminalCommand,
} from "../default-shell";
import {
  buildPaneTarget,
  requireTmuxSession,
  TerminalPanelError,
  type TerminalPanelOptions,
} from "./panel-common";
import {
  backfillSessionAgentMetadataToPrimaryPanel,
  buildSplitPanel,
  clearMultiPanelMetadataFromSession,
  recordPanelEvent,
} from "./panel-metadata";
import { ensureTmuxPanelWorkspace } from "./panel-workspace";
import { toPanelListItem, toPanelWorkspacePayload } from "./payloads";

function assertUniqueAlias(
  panels: TerminalPanelRecord[],
  alias: string | null,
): void {
  if (!alias) {
    return;
  }
  if (panels.some((panel) => panel.alias === alias)) {
    throw new TerminalPanelError(409, "Terminal panel alias already exists");
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
    throw new TerminalPanelError(409, "Terminal panel role already exists");
  }
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
  options: TerminalPanelOptions,
  params: CreateTerminalPanelSplitParams,
): Promise<{ panel: TerminalPanelRecord; workspace: TerminalPanelWorkspace }> {
  const tmuxService = requireTmuxSession(session, options.tmuxService);
  if (!options.runtimeRegistry || !options.ptyService) {
    throw new TerminalPanelError(503, "Terminal runtime service unavailable");
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
    throw new TerminalPanelError(404, "Source panel not found");
  }
  await backfillSessionAgentMetadataToPrimaryPanel(
    terminalSessionManager,
    session,
    sourcePanel,
  );

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
  const previousWorkspace = terminalSessionManager.getPanelWorkspace(
    session.id,
  );
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
  await clearMultiPanelMetadataFromSession(
    terminalSessionManager,
    session,
    terminalSessionManager.listPanels(session.id),
  );
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
    throw new TerminalPanelError(500, "Terminal panel workspace missing");
  }
  return { panel, workspace };
}
