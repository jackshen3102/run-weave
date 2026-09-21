/** One-shot navigation selection, scoped to a Backend; never a server session mutation. */
export interface TerminalNavigationSelection {
  parentProjectId: string | null;
  projectId: string | null;
  terminalSessionId: string | null;
  panelId?: string;
}
const pending = new Map<string, TerminalNavigationSelection>();
export function setTerminalNavigation(
  scope: string,
  selection: TerminalNavigationSelection,
) {
  pending.set(scope, selection);
}
export function takeTerminalNavigation(scope: string, sessionId?: string) {
  const selection = pending.get(scope);
  pending.delete(scope);
  return selection && (!sessionId || selection.terminalSessionId === sessionId)
    ? selection
    : undefined;
}
