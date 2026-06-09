import type { TerminalState } from "@browser-viewer/shared";

export class TerminalStateStore {
  private readonly states = new Map<string, TerminalState>();

  get(terminalSessionId: string): TerminalState | null {
    return this.states.get(terminalSessionId) ?? null;
  }

  set(terminalSessionId: string, state: TerminalState): TerminalState {
    this.states.set(terminalSessionId, state);
    return state;
  }

  delete(terminalSessionId: string): void {
    this.states.delete(terminalSessionId);
  }
}
