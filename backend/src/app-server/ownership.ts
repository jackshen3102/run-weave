import type { AppServerEventEnvelope } from "@runweave/shared/app-server-events";
import type { TerminalSessionManager } from "../terminal/manager";

export function isEventOwnedByThisBackend(
  event: AppServerEventEnvelope,
  terminalSessionManager: TerminalSessionManager,
): boolean {
  const terminalSessionId = event.scope?.terminalSessionId;
  if (terminalSessionId) {
    return terminalSessionManager.getSession(terminalSessionId) !== undefined;
  }

  const projectId = event.scope?.projectId;
  if (projectId) {
    return terminalSessionManager.getProject(projectId) !== undefined;
  }

  return false;
}
