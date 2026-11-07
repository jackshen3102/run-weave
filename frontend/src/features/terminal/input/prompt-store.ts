import { create } from "zustand";

interface ComposerInsertionTarget {
  destination: "composer";
  panelId: string | null;
}

interface TerminalPromptInsertionRequest {
  id: number;
  terminalSessionId: string;
  text: string;
  target?: ComposerInsertionTarget;
}

interface TerminalPromptInsertionStore {
  requests: TerminalPromptInsertionRequest[];
  requestInsertion: (terminalSessionId: string, text: string, target?: ComposerInsertionTarget) => void;
  consumeInsertion: (id: number) => void;
}

let nextPromptInsertionId = 1;

export const useTerminalPromptInsertionStore =
  create<TerminalPromptInsertionStore>((set) => ({
    requests: [],
    requestInsertion: (terminalSessionId, text, target) =>
      set((state) => ({
        requests: [
          ...state.requests,
          {
            id: nextPromptInsertionId++,
            terminalSessionId,
            text,
            target,
          },
        ],
      })),
    consumeInsertion: (id) =>
      set((state) => ({
        requests: state.requests.filter((request) => request.id !== id),
      })),
  }));
