import { useTerminalPromptInsertionStore } from "../../../features/terminal/input/prompt-store";

interface ComposerInsertionRequest {
  id: number;
  text: string;
  target?: { destination: "composer"; panelId: string | null };
}

export function consumeComposerInsertion(
  request: ComposerInsertionRequest,
  activePanelId: string | null,
  insertDraft: (text: string) => void,
  consume: (id: number) => void,
): boolean {
  if (request.target?.destination !== "composer") return false;
  if (request.target.panelId === activePanelId) {
    insertDraft(request.text);
  }
  consume(request.id);
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
