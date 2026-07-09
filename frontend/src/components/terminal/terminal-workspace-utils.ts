import type { TerminalPanelWorkspace } from "@runweave/shared";

export const HEADLESS_TERMINAL_CONNECTION_DELAY_MS = 1_500;
export const MAX_HEADLESS_TERMINAL_CONNECTIONS = 4;

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

export function parseTerminalActivityTime(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
