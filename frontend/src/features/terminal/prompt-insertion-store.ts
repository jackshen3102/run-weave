import { create } from "zustand";

interface TerminalPromptInsertionRequest {
  id: number;
  terminalSessionId: string;
  text: string;
}

interface TerminalPromptInsertionStore {
  requests: TerminalPromptInsertionRequest[];
  requestInsertion: (terminalSessionId: string, text: string) => void;
  consumeInsertion: (id: number) => void;
}

let nextPromptInsertionId = 1;

export const useTerminalPromptInsertionStore =
  create<TerminalPromptInsertionStore>((set) => ({
    requests: [],
    requestInsertion: (terminalSessionId, text) =>
      set((state) => ({
        requests: [
          ...state.requests,
          {
            id: nextPromptInsertionId++,
            terminalSessionId,
            text,
          },
        ],
      })),
    consumeInsertion: (id) =>
      set((state) => ({
        requests: state.requests.filter((request) => request.id !== id),
      })),
  }));
