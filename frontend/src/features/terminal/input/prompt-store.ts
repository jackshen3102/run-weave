import { create } from "zustand";

export type ComposerInsertionResult = "inserted" | "target-changed" | "cancelled";
export type ComposerInsertionReceipt = (result: ComposerInsertionResult) => void;
export type InsertReviewFeedback = (text: string, receipt: ComposerInsertionReceipt) => () => void;

interface ComposerInsertionTarget {
  destination: "composer";
  panelId: string | null;
  scope?: string;
}

interface TerminalPromptInsertionRequest {
  id: number;
  terminalSessionId: string;
  text: string;
  target?: ComposerInsertionTarget;
  receipt?: ComposerInsertionReceipt;
}

interface TerminalPromptInsertionStore {
  requests: TerminalPromptInsertionRequest[];
  requestInsertion: (terminalSessionId: string, text: string, target?: ComposerInsertionTarget,
    receipt?: ComposerInsertionReceipt) => () => void;
  consumeInsertion: (id: number, result?: ComposerInsertionResult, insert?: () => boolean | void) => void;
}

let nextPromptInsertionId = 1;

export const useTerminalPromptInsertionStore = create<TerminalPromptInsertionStore>((set, get) => {
  // Claim by removing before performing side effects: cancellation and consumption
  // cannot both insert or acknowledge the same in-process request.
  const consumeInsertion = (id: number, result: ComposerInsertionResult = "cancelled", insert?: () => boolean | void) => {
    const request = get().requests.find((item) => item.id === id);
    if (!request) return;
    set((state) => ({ requests: state.requests.filter((item) => item.id !== id) }));
    let outcome = result;
    try {
      if (insert?.() === false) outcome = "cancelled";
    } catch {
      outcome = "cancelled";
    }
    // Do not catch the receipt itself and invoke it a second time if it throws.
    request.receipt?.(outcome);
  };
  return {
    requests: [],
    requestInsertion: (terminalSessionId, text, target, receipt) => {
      const id = nextPromptInsertionId++;
      set((state) => ({ requests: [...state.requests, { id, terminalSessionId, text, target, receipt }] }));
      return () => consumeInsertion(id, "cancelled");
    },
    consumeInsertion,
  };
});
