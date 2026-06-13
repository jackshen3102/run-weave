import type { TerminalState } from "@runweave/shared";

export class TerminalStateStore {
  private readonly states = new Map<string, TerminalState>();

  constructor(initialStates: Iterable<[string, TerminalState]> = []) {
    for (const [terminalSessionId, state] of initialStates) {
      this.states.set(terminalSessionId, state);
    }
  }

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
