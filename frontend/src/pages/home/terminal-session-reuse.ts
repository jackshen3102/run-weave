import type { TerminalSessionListItem } from "@browser-viewer/shared";
import { loadRecentTerminalSelection } from "../../features/terminal/recent-selection";

export function resolveReusableTerminalSession(
  terminalSessions: TerminalSessionListItem[],
  apiBase: string,
): TerminalSessionListItem | null {
  const recentSelection = loadRecentTerminalSelection(apiBase);
  if (recentSelection) {
    const recentSession = terminalSessions.find(
      (session) =>
        session.projectId === recentSelection.projectId &&
        session.terminalSessionId === recentSelection.terminalSessionId,
    );
    if (recentSession) {
      return recentSession;
    }
  }

  const runningSessions = terminalSessions
    .filter((session) => session.status === "running")
    .sort((left, right) => {
      return (
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
      );
    });

  return runningSessions[0] ?? null;
}
