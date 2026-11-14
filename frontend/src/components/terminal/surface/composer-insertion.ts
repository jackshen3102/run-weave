import { type ComposerInsertionResult, type ComposerInsertionReceipt, useTerminalPromptInsertionStore } from "../../../features/terminal/input/prompt-store";

interface ComposerInsertionRequest {
  id: number;
  text: string;
  receipt?: ComposerInsertionReceipt;
  target?: { destination: "composer"; panelId: string | null; scope?: string };
}

export function consumeComposerInsertion(
  request: ComposerInsertionRequest,
  activePanelId: string | null,
  insertDraft: (text: string) => boolean | void,
  consume: (id: number, result?: ComposerInsertionResult, insert?: () => boolean | void) => void,
  eligible = true,
  scope?: string,
): boolean {
  if (request.target?.destination !== "composer") return false;
  const matches = request.target.panelId === activePanelId &&
    (request.target.scope === undefined || request.target.scope === scope) &&
    (!request.receipt || eligible);
  consume(request.id, matches ? "inserted" : "target-changed",
    matches ? () => insertDraft(request.text) : undefined);
  return true;
}

export function usePromptInsertionRequest(active: boolean, terminalSessionId: string) {
  return useTerminalPromptInsertionStore((state) =>
    active
      ? (state.requests.find(
          (request) => request.terminalSessionId === terminalSessionId,
        ) ?? null)
      : null,
  );
}
