import type { TerminalState } from "@runweave/shared/terminal/state";
import type { TerminalSessionManager } from "../manager";
import {
  aggregatePanelTerminalState,
  type TerminalStateService,
} from "../terminal-state-service";

type TerminalSession = NonNullable<
  ReturnType<TerminalSessionManager["getSession"]>
>;

export function resolveEffectiveTerminalState(
  terminalSessionManager: TerminalSessionManager,
  terminalStateService: TerminalStateService,
  session: TerminalSession,
): TerminalState;
export function resolveEffectiveTerminalState(
  terminalSessionManager: TerminalSessionManager,
  terminalStateService: TerminalStateService | undefined,
  session: TerminalSession,
): TerminalState | undefined;
export function resolveEffectiveTerminalState(
  terminalSessionManager: TerminalSessionManager,
  terminalStateService: TerminalStateService | undefined,
  session: TerminalSession,
): TerminalState | undefined {
  const runningPanels = terminalSessionManager
    .listPanels(session.id)
    .filter((panel) => panel.status === "running");
  if (runningPanels.length > 0) {
    return aggregatePanelTerminalState(runningPanels);
  }
  return (
    terminalStateService?.getCurrent(session.id, session) ??
    session.terminalState
  );
}
