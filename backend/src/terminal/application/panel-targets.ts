import type {
  TerminalPanelRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager";
import { resolveTmuxTarget } from "../runtime-launcher";
import type { TmuxService } from "../tmux-service";
import type { TerminalEventService } from "../terminal-event-service";
import {
  buildPaneTarget,
  requireTmuxSession,
  TerminalPanelError,
  type TerminalPanelOptions,
  type TerminalPanelTargetResolution,
} from "./panel-common";
import { recordPanelEvent } from "./panel-metadata";
import { ensureTmuxPanelWorkspace } from "./panel-workspace";

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
  const previousActive = terminalSessionManager.getPanelWorkspace(
    session.id,
  )?.activePanelId;
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
    throw new TerminalPanelError(409, `Multiple panels match ${field}`, {
      panels: matches.map((panel) => ({
        panelId: panel.id,
        alias: panel.alias,
        role: panel.role,
      })),
    });
  }
  throw new TerminalPanelError(404, "Terminal panel not found");
}

export async function resolvePanelTarget(
  terminalSessionManager: TerminalSessionManager,
  session: TerminalSessionRecord,
  options: Pick<TerminalPanelOptions, "tmuxService" | "terminalEventService">,
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
    throw new TerminalPanelError(404, "Terminal panel not found");
  }
  return {
    panel,
    paneTarget: buildPaneTarget(session, tmuxService, panel),
  };
}
