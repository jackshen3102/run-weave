import type { TerminalPanelWorkspace } from "@runweave/shared/terminal/panel";

export function formatHistoryPanelLabel(
  panel: TerminalPanelWorkspace["panels"][number],
): string {
  return panel.alias || panel.role || panel.panelId.slice(0, 8);
}

export function resolveHistoryPanelId(
  workspace: TerminalPanelWorkspace | null,
  activePanelId: string | null,
): string | null {
  if (!workspace) {
    return null;
  }
  return (
    workspace.panels.find((panel) => panel.panelId === activePanelId)?.panelId ??
    workspace.panels.find((panel) => panel.panelId === workspace.activePanelId)
      ?.panelId ??
    workspace.panels.find((panel) => panel.focused)?.panelId ??
    workspace.panels[0]?.panelId ??
    null
  );
}
