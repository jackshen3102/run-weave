import type { TerminalSessionManager } from "../manager/manager";

export function resolveHookPanel(
  terminalSessionManager: TerminalSessionManager,
  terminalSessionId: string,
  panelId: string | null,
  tmuxPaneId: string | null,
):
  | {
      ok: true;
      panel: ReturnType<TerminalSessionManager["getPanel"]> | null;
    }
  | { ok: false } {
  const byId = panelId
    ? (terminalSessionManager.getPanel(panelId) ?? null)
    : null;
  const panels = tmuxPaneId
    ? terminalSessionManager.listPanels(terminalSessionId)
    : [];
  const paneMatches = tmuxPaneId
    ? panels.filter((panel) => panel.tmuxPaneId === tmuxPaneId)
    : [];
  const byPane = paneMatches.length === 1 ? paneMatches[0] : null;

  if (panelId) {
    if (
      byId?.terminalSessionId === terminalSessionId &&
      (!tmuxPaneId || byId.tmuxPaneId === tmuxPaneId)
    ) {
      return { ok: true, panel: byId };
    }
    return tmuxPaneId && byPane ? { ok: true, panel: byPane } : { ok: false };
  }
  if (tmuxPaneId) {
    return byPane ? { ok: true, panel: byPane } : { ok: false };
  }
  const runningPanels = terminalSessionManager
    .listPanels(terminalSessionId)
    .filter((panel) => panel.status === "running");
  if (runningPanels.length === 1) {
    return { ok: true, panel: runningPanels[0]! };
  }
  return runningPanels.length === 0
    ? { ok: true, panel: null }
    : { ok: false };
}
